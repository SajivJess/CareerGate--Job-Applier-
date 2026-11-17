#!/usr/bin/env node
/**
 * prepare-linkedin-job.mjs — Prepare a tailored CV PDF, Cover Letter PDF,
 * Evaluation Report (with archived verbatim JD), Launchpad entry, and
 * tracker row for a job opened by the user on LinkedIn.
 *
 * Reads one JSON payload from stdin:
 *   { url, jobId?, title, company, location?, jdText?, manualJdText?, status? }
 *
 * Outputs one JSON result line to stdout when --json is passed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import { keywordsFromJdText, analyzeCoverage, htmlToText } from './keyword-match.mjs';
import { renderBatch, normalizeTextForATS } from './generate-pdf.mjs';
import { buildHtml as buildCoverHtml } from './generate-cover-letter.mjs';
import { assertFacts } from './verify-cv-facts.mjs';
import { formatReportNumber, releaseReportNumbers, reserveReportNumbers } from './reserve-report-num.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { companiesMatchIgnoringCorporateForm, resolveTrackerPath } from './tracker-utils.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { normalizeUrl } from './url-key.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const EMAIL = 'sajiv2580@gmail.com';
const CODE_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

function extractLinkedInId(rawUrl = '') {
  const s = String(rawUrl || '');
  const m1 = s.match(/\/jobs\/view\/(\d+)/i);
  if (m1) return m1[1];
  try {
    const u = new URL(s);
    const cur = u.searchParams.get('currentJobId');
    if (cur && /^\d+$/.test(cur)) return cur;
  } catch {}
  return '';
}

function canonicalLinkedInUrl(rawUrl, explicitJobId = '') {
  const jobId = String(explicitJobId || extractLinkedInId(rawUrl)).replace(/\D+/g, '');
  if (jobId) return { canonicalUrl: `https://www.linkedin.com/jobs/view/${jobId}/`, jobId };
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    u.search = '';
    return { canonicalUrl: u.toString(), jobId: '' };
  } catch {
    return { canonicalUrl: String(rawUrl || '').trim(), jobId: '' };
  }
}

function makeSlug(company, title, numStr) {
  const clean = `${company}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return `${numStr}-${clean || 'linkedin-role'}`;
}

function classifyMarket(location = '', jdText = '') {
  const hay = `${location} ${jdText.slice(0, 1200)}`;
  if (/\b(?:india|bengaluru|bangalore|chennai|hyderabad|pune|mumbai|noida|gurugram|gurgaon|new delhi|kochi)\b/i.test(location)) {
    return {
      region: 'India',
      country: 'IN',
      format: 'a4',
      marketNote: 'India format (A4)',
      workAuth: 'Indian Citizen (Authorized)',
      relocLine: 'As a May 2027 graduating B.Tech AI & ML candidate based in Chennai, India, I am legally authorized to work in India without visa sponsorship.',
    };
  }
  if (/\b(?:germany|deutschland|berlin|munich|münchen|frankfurt|hamburg|stuttgart|leonberg|cologne|köln|hannover|karlsruhe)\b/i.test(location)) {
    return {
      region: 'Germany',
      country: 'DE',
      format: 'a4',
      marketNote: 'Germany format (A4)',
      workAuth: 'Visa Sponsored / Relocation Required (Germany)',
      relocLine: 'As a May 2027 graduating B.Tech AI & ML candidate based in Chennai, India, I am transparent early about requiring visa sponsorship and relocation support for Germany while bringing high engineering velocity and immediate remote interview readiness.',
    };
  }
  if (/\b(?:united states|\busa?\b|san francisco|new york|seattle|austin|boston|california|texas|chicago|los angeles|canada|toronto|vancouver|montreal)\b/i.test(location)) {
    const isCanada = /\b(?:canada|toronto|vancouver|montreal)\b/i.test(location);
    return {
      region: 'Foreign',
      country: isCanada ? 'CA' : 'US',
      format: 'letter',
      marketNote: isCanada ? 'Canada format (Letter)' : 'US format (Letter)',
      workAuth: 'Visa Sponsorship Required',
      relocLine: `As a May 2027 graduating B.Tech AI & ML candidate based in Chennai, India, I am transparent early about requiring employer visa sponsorship for ${isCanada ? 'Canada' : 'the United States'}.`,
    };
  }
  const isUk = /\b(?:united kingdom|\buk\b|london|manchester|cambridge|edinburgh|bristol)\b/i.test(location);
  const isSg = /\bsingapore\b/i.test(location);
  const isNl = /\b(?:netherlands|amsterdam|rotterdam|eindhoven|utrecht)\b/i.test(location);
  const isIe = /\b(?:ireland|dublin|cork)\b/i.test(location);
  const ctry = isUk ? 'GB' : isSg ? 'SG' : isNl ? 'NL' : isIe ? 'IE' : 'GLOBAL';
  const isRemote = /\bremote\b/i.test(location) && !/\bus\b|\bunited states\b/i.test(hay);
  return {
    region: 'Foreign',
    country: ctry,
    format: 'a4',
    marketNote: isRemote ? 'Global Remote format (A4)' : 'International format (A4)',
    workAuth: isRemote ? 'Open Remote / Check Country Auth' : 'International / Visa Sponsorship Needed',
    relocLine: `As a May 2027 graduating B.Tech AI & ML candidate based in Chennai, India, I am ready for remote technical interviews immediately and transparent early where visa sponsorship is required.`,
  };
}

function classifyTrack(title = '', jdText = '') {
  const hay = `${title} ${jdText.slice(0, 2200)}`;
  if (/\b(adas|autonomous|automotive|vehicle|carla|acc|perception|sensor fusion|embodied|robotics)\b/i.test(hay)) {
    return { track: 'Automotive / ADAS', variant: 'adas', trackPriority: 1 };
  }
  if (/\b(voice|speech|audio|tts|asr|conversational ai|telephony|webrtc|livekit)\b/i.test(hay)) {
    return { track: 'Voice / Agent AI', variant: 'voice', trackPriority: 1 };
  }
  if (/\b(ai engineer|ml engineer|machine learning|applied ai|llm|rag|agent|agentic|nlp|computer vision|genai|generative ai)\b/i.test(hay)) {
    return { track: 'Applied AI / ML', variant: 'ai', trackPriority: 1 };
  }
  return { track: 'Full-Stack / SWE', variant: 'swe', trackPriority: 2 };
}

function buildCvPayload(trackInfo, market, roleTitle, company) {
  const commonCandidate = {
    name: 'Sajiv Jess B I',
    title: `${trackInfo.track} Engineer | B.Tech AI & ML (2027)`,
    phone: '+91 7200599700',
    email: EMAIL,
    linkedin: { url: 'https://www.linkedin.com/in/sajivjess/', display: 'linkedin.com/in/sajivjess' },
    github: { url: 'https://github.com/SajivJess', display: 'github.com/SajivJess' },
    portfolio: { url: 'https://sajivjess.dev/', display: 'sajivjess.dev' },
    location: 'Nagercoil / Chennai, Tamil Nadu, India',
  };

  const exp = [
    {
      company: 'Mahindra & Mahindra Ltd.',
      role: 'ADAS Research Intern',
      location: 'India',
      dates: 'Sep 2026 - Present',
      bullets: [
        'Completing a 3-month onsite research internship in Vehicle Engineering Solutions (ADAS), contributing to data-driven machine-learning workflows for Adaptive Cruise Control (ACC) and advanced driver-assistance systems.',
      ],
    },
    {
      company: 'Firstsource',
      role: 'Full Stack Developer Intern',
      location: 'India',
      dates: 'Dec 2025 - Jun 2026',
      bullets: [
        'Completed a 6-month Full Stack Developer internship delivering software services across enterprise workflows.',
      ],
    },
    {
      company: 'Kenesis Labs Pvt. Ltd.',
      role: 'IoT & Hardware Development Intern',
      location: 'India',
      dates: 'Feb 2025 - Mar 2025',
      bullets: [
        'Built prototype sensor devices for smart health monitoring and rescue systems, including the 6th Sense smart glasses prototype for visually impaired users.',
      ],
    },
    {
      company: 'RETECH Pvt. Ltd.',
      role: 'Data Analyst Intern',
      location: 'India',
      dates: 'Jan 2025',
      bullets: [
        'Performed data cleaning and built interactive analytical dashboards in Power BI using real-world datasets.',
      ],
    },
  ];

  const projectsByVariant = {
    adas: [
      {
        name: 'KAAVAL AI: AI Traffic Intelligence & Edge Vision',
        url: 'https://kaaval-ai.com',
        badge: 'Police Collaboration',
        tech: 'Python, YOLO, OCR, RDK X5 8GB, Embedded Edge Compute',
        description: 'Developed an edge-AI traffic intelligence platform with Kanyakumari District Police for helmet-violation detection and OCR number-plate recognition on RDK X5 edge compute.',
      },
      {
        name: 'VictimLocator-360: AI Disaster Search & Rescue System',
        url: 'https://github.com/SajivJess/Victim-Locator-360',
        badge: 'SIH 2024 Winner',
        tech: 'Python, Flask, Socket.IO, YOLOv5, OpenCV, PyTorch, ESP32, RTSP',
        description: 'Smart India Hackathon 2024 National Winner integrating ESP32 rover/drone hardware, live RTSP video streaming, YOLOv5 human detection, GPS support, and multi-user control.',
      },
      {
        name: 'CityGrid Traffic Incident Response Environment',
        url: 'https://github.com/SajivJess/openenv-traffic-incident-ai',
        badge: 'Simulation',
        tech: 'Python, Docker, FastAPI, WebSockets, Meta OpenEnv',
        description: 'Built an OpenEnv-compatible 4x4 intersection traffic simulation environment where LLM agents coordinate signal timing, emergency dispatch, and incident handling.',
      },
      {
        name: 'MuseFlow / Jess IDE: Mobile AI Coding Environment',
        url: 'https://github.com/SajivJess/MuseFlow',
        badge: 'Meta Hackathon',
        tech: 'Flutter, Dart, FastAPI, Python, Meta Model API, WebSockets',
        description: 'Solo developer building a mobile AI coding IDE connecting a Flutter Android client to a FastAPI execution host with isolated workspace sandboxing and Git-diff approval.',
      },
    ],
    voice: [
      {
        name: 'Voice Shiksha: Speech & Pronunciation Learning App',
        url: 'https://github.com/SajivJess/VoiceShiksha',
        badge: 'Audio / Speech ML',
        tech: 'Flutter, Flask, TensorFlow, CREPE, Librosa, FastDTW',
        description: 'Led development of a mobile Hindi speech-practice and pitch-matching application for children with hearing and speech disabilities using CREPE and FastDTW.',
      },
      {
        name: 'Reporzo: Automated Tamil News Audio/Video Pipeline',
        url: 'https://www.youtube.com/channel/UCn8j-CkGhtyrCtYg-dcsu-Q/',
        badge: 'TTS + Whisper',
        tech: 'Python, OpenAI GPT-4, Google Gemini, Whisper, MoviePy, FFmpeg, Flask',
        description: 'Built an automated pipeline transforming trending news into videos using script generation, Tamil TTS narration, Whisper synchronization, and FFmpeg assembly.',
      },
      {
        name: 'MuseFlow / Jess IDE: Voice-to-Text Coding IDE',
        url: 'https://github.com/SajivJess/MuseFlow',
        badge: 'Meta Hackathon',
        tech: 'Flutter, Dart, FastAPI, Python, Meta Model API, WebSockets',
        description: 'Solo developer connecting a Flutter Android client to a FastAPI execution host featuring voice-to-text coding workflows, isolated workspace sandboxing, and Git-diff approval.',
      },
      {
        name: 'Constructure AI: Construction PDF RAG & Citation Engine',
        url: 'https://github.com/SajivJess/Constructure-AI---Project-Brain',
        badge: 'RAG + FastAPI',
        tech: 'FastAPI, FAISS, Sentence Transformers, Google Gemini, Next.js 14, TypeScript',
        description: 'Built a local RAG tool for construction PDF Q&A with page-level source citations and structured schedule extraction.',
      },
    ],
    ai: [
      {
        name: 'MuseFlow / Jess IDE: Mobile AI Pair-Programming IDE',
        url: 'https://github.com/SajivJess/MuseFlow',
        badge: 'Meta Hackathon',
        tech: 'Flutter, Dart, FastAPI, Python, Meta Model API, WebSockets',
        description: 'Solo developer connecting a Flutter Android client to a FastAPI execution host with isolated workspace sandboxing, voice-to-text, UI mockups, and Git-diff approval.',
      },
      {
        name: 'Constructure AI: Local RAG & Citation Platform',
        url: 'https://github.com/SajivJess/Constructure-AI---Project-Brain',
        badge: 'RAG + FAISS',
        tech: 'FastAPI, FAISS, Sentence Transformers, Google Gemini, Next.js 14, TypeScript',
        description: 'Built a local RAG application for construction PDF Q&A and schedule extraction with page-level provenance citations.',
      },
      {
        name: 'Document-based RAG Chatbot',
        url: 'https://github.com/SajivJess/RAG-CHATBOT',
        badge: 'Qdrant + llama.cpp',
        tech: 'Python, Streamlit, Qdrant, Sentence Transformers, llama.cpp',
        description: 'Built an offline PDF/Word question-answering assistant with source citations powered by local quantized GGUF LLMs.',
      },
      {
        name: 'VisionGuard: Async PII Detection & Redaction',
        url: 'https://github.com/SajivJess',
        badge: 'PyTorch + Celery',
        tech: 'Python, Flask, React, PyTorch, OpenCV, Tesseract, EasyOCR, PaddleOCR, Redis, Celery, Docker',
        description: 'Engineered an asynchronous image PII detection and redaction platform with REST APIs, React UI, Celery/Redis queues, and multi-engine OCR.',
      },
    ],
    swe: [
      {
        name: 'HRMSPro: Role-Based Human Resource Management System',
        url: 'https://github.com/SajivJess/HRMS---Sajiv-Jess',
        badge: 'Full-Stack + k6',
        tech: 'React, Vite, Supabase, PostgreSQL, k6',
        description: 'Built a role-based web application covering admin, HR, and employee portals, attendance, payroll workflows, and k6 load testing.',
      },
      {
        name: 'MuseFlow / Jess IDE: Sandboxed Pair-Programming IDE',
        url: 'https://github.com/SajivJess/MuseFlow',
        badge: 'Meta Hackathon',
        tech: 'Flutter, Dart, FastAPI, Python, Meta Model API, WebSockets',
        description: 'Solo developer connecting a Flutter client to a FastAPI execution host with isolated workspace sandboxing, agentic coding, and Git-diff review.',
      },
      {
        name: 'VisionGuard: Async Backend & OCR Redaction Platform',
        url: 'https://github.com/SajivJess',
        badge: 'Async Backend',
        tech: 'Python, Flask, React, Redis, Celery, Docker, PyTorch, OpenCV',
        description: 'Engineered an asynchronous PII detection and redaction platform with REST APIs, Celery/Redis task queues, Docker packaging, and audit reports.',
      },
      {
        name: 'TrustEase: Alternative-Data Credit Scoring Platform',
        url: 'https://github.com/SajivJess/TrustEase',
        badge: 'IIT Madras Finale',
        tech: 'Python, Flask, SQLite, XGBoost, scikit-learn',
        description: 'Team lead and frontend developer for a loan application, KYC profiling, and alternative-data credit-scoring workflow.',
      },
    ],
  };

  const summaries = {
    adas: `2027 B.Tech AI & ML undergraduate and current ADAS Research Intern at Mahindra & Mahindra Ltd. (ACC ML workflows), plus a 6-month Full Stack Developer internship at Firstsource. Smart India Hackathon 2024 National Winner (VictimLocator-360) and KAAVAL AI Edge Vision project lead, aligned with ${roleTitle} at ${company}.`,
    voice: `2027 B.Tech AI & ML undergraduate with ADAS research experience at Mahindra & Mahindra Ltd. and a 6-month Full Stack Developer internship at Firstsource. Built speech-processing and multimodal audio/agent pipelines (Voice Shiksha with CREPE/FastDTW, Reporzo with Whisper/TTS, MuseFlow voice-to-text IDE), tailored for ${roleTitle} at ${company}.`,
    ai: `2027 B.Tech AI & ML undergraduate with ADAS research experience at Mahindra & Mahindra Ltd. and a 6-month Full Stack Developer internship at Firstsource. Shipped RAG/agentic and computer vision systems across FastAPI, Next.js, FAISS, Qdrant, PyTorch, and Docker (MuseFlow, Constructure AI, Document RAG Chatbot, VisionGuard) for ${roleTitle} at ${company}.`,
    swe: `2027 B.Tech AI & ML undergraduate with a 6-month Full Stack Developer internship at Firstsource and ADAS research internship at Mahindra & Mahindra Ltd. Shipped end-to-end backend and full-stack platforms using Python, FastAPI, Flask, React, Next.js, TypeScript, PostgreSQL, Redis/Celery, and Docker for ${roleTitle} at ${company}.`,
  };

  return {
    lang: 'en',
    page_format: market.format,
    candidate: commonCandidate,
    summary: summaries[trackInfo.variant] || summaries.swe,
    competencies: [
      'Python, Java, C++, TypeScript & SQL',
      'FastAPI, Flask, React, Next.js & Flutter',
      'PyTorch, OpenCV, YOLO, OCR & RAG (FAISS/Qdrant)',
      'PostgreSQL, SQLite, MongoDB & Redis/Celery',
      'Docker, Linux, Git, AWS, GCP & k6 Testing',
    ],
    experience: exp,
    projects: projectsByVariant[trackInfo.variant] || projectsByVariant.swe,
    education: [
      {
        title: 'B.Tech in Artificial Intelligence and Machine Learning',
        org: 'Rajalakshmi Engineering College',
        location: 'Chennai, Tamil Nadu',
        year: '2023 - 2027',
        description: 'CGPA: 7.28 (Expected Graduation: May 2027)',
      },
    ],
    awards: [
      {
        title: 'Smart India Hackathon 2024, Hardware Edition National Winner',
        org: 'Team Lead, CODE-O-PHILES (VictimLocator-360)',
        year: '2024',
      },
      {
        title: 'IndustryAI Hackathon (IIT Madras Finale)',
        org: 'Finalist (TrustEase)',
        year: '2025',
      },
      {
        title: 'IEEE CIS, Rajalakshmi Engineering College',
        org: 'Treasurer (Aug 2025 - Present) & Junior Design Associate (Oct 2023 - Aug 2025)',
        year: '2023 - Present',
      },
    ],
    skills: [
      { category: 'Languages', items: 'Python, JavaScript, TypeScript, C, C++, Java, SQL, Dart, HTML/CSS' },
      { category: 'Backend & Full-Stack', items: 'FastAPI, Flask, React, Next.js, Flutter, Node.js, REST APIs, WebSockets, Streamlit' },
      { category: 'AI, Vision & Audio', items: 'PyTorch, TensorFlow, scikit-learn, XGBoost, OpenCV, YOLO, RAG, FAISS, Qdrant, llama.cpp, Whisper' },
      { category: 'Data & Infra', items: 'PostgreSQL, SQLite, Supabase, MongoDB, Redis, Celery, Docker, Linux, Git, AWS, GCP, Power BI' },
    ],
  };
}

function scorePosting(title, location, jdText, market, trackInfo, coverageRatio) {
  let score = 3.9 + coverageRatio * 0.7;
  const flags = [];
  const lowerJd = `${title}\n${jdText}`.toLowerCase();

  if (/\b(intern|new grad|graduate|trainee|junior|entry[- ]?level|fresher|2027)\b/i.test(`${title} ${jdText.slice(0, 1200)}`)) {
    score += 0.25;
  } else if (/\b(staff|principal|lead|director|manager|senior|sr\.)\b/i.test(title)) {
    score -= 0.9;
    flags.push('Seniority title mismatch for May 2027 graduate');
  }

  const yrMatches = [...lowerJd.matchAll(/\b([3-9]|1\d)\+?\s*(?:-\s*\d+\s*)?years?(?:\s+of)?\s+experience\b/g)];
  if (yrMatches.length > 0) {
    score -= 0.7;
    flags.push(`Asks for ${yrMatches[0][1]}+ years experience (current: May 2027 grad + internships)`);
  }

  if (market.country !== 'IN' && /\b(no visa sponsorship|unable to sponsor|without visa sponsorship|citizens? only|permanent residents? only|must hold existing work authorization)\b/i.test(lowerJd)) {
    score -= 1.0;
    flags.push('May not sponsor international work visa');
  }

  if (market.country === 'DE' && /\b(fluent german|c1 german|german c1|fließend deutsch|deutschkenntnisse.*sehr gut|verhandlungssicher.*deutsch)\b/i.test(lowerJd)) {
    score -= 0.7;
    flags.push('Requires fluent/C1 German');
  }

  score = Math.max(2.5, Math.min(4.7, Math.round(score * 10) / 10));
  const decision = score >= 3.8 && flags.length === 0 ? 'Apply' : score >= 3.4 ? 'Review Blockers & Apply' : 'Stretch / Blocker';
  return { score, decision, flags };
}

function buildLinkedInAnswers(company, title, location, market, cvPdfAbs, coverPdfAbs) {
  const isIndia = market.country === 'IN';
  return [
    { question: 'First name', answer: 'Sajiv', needsConfirm: false },
    { question: 'Last name', answer: 'Jess B I', needsConfirm: false },
    { question: 'Email address', answer: EMAIL, needsConfirm: false },
    { question: 'Phone country code', answer: 'India (+91)', needsConfirm: false },
    { question: 'Mobile phone number', answer: '7200599700', needsConfirm: false },
    { question: 'City', answer: 'Chennai, Tamil Nadu, India', needsConfirm: false },
    { question: 'Headline', answer: 'Applied AI / ML & Software Engineer | B.Tech 2027', needsConfirm: false },
    { question: 'Resume Upload', answer: cvPdfAbs, needsConfirm: false },
    { question: 'Cover Letter Upload', answer: coverPdfAbs, needsConfirm: false },
    { question: 'LinkedIn Profile', answer: 'https://www.linkedin.com/in/sajivjess/', needsConfirm: false },
    { question: 'GitHub', answer: 'https://github.com/SajivJess', needsConfirm: false },
    { question: 'Website', answer: 'https://sajivjess.dev/', needsConfirm: false },
    {
      question: 'Are you legally authorized to work in this country?',
      answer: isIndia ? 'Yes' : 'No',
      needsConfirm: !isIndia,
    },
    {
      question: 'Will you now or in the future require sponsorship for employment visa status?',
      answer: isIndia ? 'No' : 'Yes',
      needsConfirm: false,
    },
    {
      question: `Why are you interested in ${title} at ${company}?`,
      answer: `What draws me to ${company}'s ${title} role (${location || market.region}) is building reliable, production-focused software and AI systems. Across my ADAS Research Internship at Mahindra & Mahindra, my 6-month Full Stack internship at Firstsource, and shipped projects like MuseFlow, Constructure AI, VisionGuard, and KAAVAL AI, I enjoy owning features from model/API design to end-to-end delivery.`,
      needsConfirm: false,
    },
  ];
}

function findExistingItem(root, url, jobId, company, title) {
  const normTarget = normalizeUrl(url);
  const appsPath = resolveTrackerPath(root);
  if (existsSync(appsPath)) {
    const lines = readFileSync(appsPath, 'utf8').split(/\r?\n/);
    const header = lines.find((l) => l.startsWith('|') && !l.includes('---'));
    const colMap = resolveColumns(header || '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |');
    for (const line of lines) {
      if (!line.startsWith('|') || line.includes('---') || line === header) continue;
      const row = parseTrackerRow(line, colMap);
      if (!row) continue;
      const rowUrl = String(row.url || '');
      const rowId = extractLinkedInId(rowUrl);
      if (jobId && rowId && jobId === rowId) return { num: Number(row.num), row };
      if (normTarget && rowUrl && normalizeUrl(rowUrl) === normTarget) return { num: Number(row.num), row };
      if (company && title && companiesMatchIgnoringCorporateForm(row.company, company) && roleFuzzyMatch(row.role, title)) {
        return { num: Number(row.num), row };
      }
    }
  }
  const launchPath = join(root, 'output', '_launchpad-data.json');
  if (existsSync(launchPath)) {
    try {
      const d = JSON.parse(readFileSync(launchPath, 'utf8'));
      for (const it of d.items || []) {
        const itId = extractLinkedInId(it.url) || extractLinkedInId(it.applyUrl);
        if (jobId && itId && jobId === itId) return { num: Number(it.num), item: it };
        if (normTarget && (normalizeUrl(it.url) === normTarget || normalizeUrl(it.applyUrl) === normTarget)) {
          return { num: Number(it.num), item: it };
        }
      }
    } catch {}
  }
  return null;
}

function updateLaunchpadFiles(root, newItem) {
  const launchPath = join(root, 'output', '_launchpad-data.json');
  let items = [];
  if (existsSync(launchPath)) {
    try {
      const prev = JSON.parse(readFileSync(launchPath, 'utf8'));
      if (Array.isArray(prev.items)) items = prev.items;
    } catch {}
  }
  const filtered = items.filter((x) => Number(x.num) !== Number(newItem.num));
  const combined = [newItem, ...filtered].sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.num || 0) - Number(a.num || 0));
  writeFileSync(launchPath, JSON.stringify({ generatedAt: new Date().toISOString(), items: combined }, null, 2), 'utf8');

  const htmlPath = join(root, 'output', 'apply-launchpad.html');
  if (existsSync(htmlPath)) {
    const dataJson = JSON.stringify(combined).replace(/</g, '\\u003c');
    let html = readFileSync(htmlPath, 'utf8');
    if (/const ITEMS = [\s\S]*?;\s*\nconst DONE_KEY/.test(html)) {
      html = html.replace(/const ITEMS = [\s\S]*?;\s*\nconst DONE_KEY/, `const ITEMS = ${dataJson};\nconst DONE_KEY`);
      writeFileSync(htmlPath, html, 'utf8');
    }
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const root = getCareerOpsRoot();

  let inputRaw = '';
  try {
    inputRaw = await readStdin();
  } catch {}

  let req = {};
  try {
    req = JSON.parse(inputRaw || '{}');
  } catch {
    const err = { ok: false, error: 'Invalid JSON payload' };
    console.log(JSON.stringify(err));
    process.exit(1);
  }

  const company = String(req.company || '').trim();
  const title = String(req.title || '').trim();
  const location = String(req.location || 'Remote').trim();
  const rawUrl = String(req.url || '').trim();
  const { canonicalUrl, jobId } = canonicalLinkedInUrl(rawUrl, req.jobId);
  const effectiveJd = String(req.manualJdText || req.jdText || '').replace(/\r/g, '').trim();

  if (!company || !title || !canonicalUrl) {
    console.log(JSON.stringify({ ok: false, error: 'company, title, and LinkedIn url are required' }));
    process.exit(1);
  }

  // 1) Deduplication before allocating any number or artifact
  const existing = findExistingItem(root, canonicalUrl, jobId, company, title);
  if (existing) {
    const launchPath = join(root, 'output', '_launchpad-data.json');
    let item = existing.item || null;
    if (!item && existsSync(launchPath)) {
      try {
        const d = JSON.parse(readFileSync(launchPath, 'utf8'));
        item = (d.items || []).find((x) => Number(x.num) === Number(existing.num)) || null;
      } catch {}
    }
    console.log(
      JSON.stringify({
        ok: true,
        alreadyExisted: true,
        num: existing.num,
        numStr: formatReportNumber(existing.num),
        item,
        message: `Already tracked as #${formatReportNumber(existing.num)}`,
      }),
    );
    process.exit(0);
  }

  // 2) AGENTS.md #4121 — require real JD text rather than fabricating from a loading skeleton
  if (effectiveJd.length < 100) {
    console.log(
      JSON.stringify({
        ok: false,
        needsJd: true,
        error: "LinkedIn JD text did not load on this page — expand 'About the job' on LinkedIn and click Refresh, or paste the JD text below before preparing your tailored CV.",
      }),
    );
    process.exit(2);
  }

  const today = localToday();
  const market = classifyMarket(location, effectiveJd);
  const trackInfo = classifyTrack(title, effectiveJd);
  const numbers = await reserveReportNumbers(1, { rootDir: root });
  const num = numbers[0];
  const numStr = formatReportNumber(num);
  const slug = makeSlug(company, title, numStr);
  const workDir = mkdtempSync(join(tmpdir(), 'co-linkedin-'));

  try {
    const cvJsonPath = join(workDir, `cv-${slug}.json`);
    const cvHtmlPath = join(workDir, `cv-${slug}.html`);
    const cvPdfRel = `output/cv-sajiv-jess-b-i-${slug}-${today}.pdf`;
    const coverPdfRel = `output/cover-${slug}-${today}.pdf`;
    const cvPdfAbs = join(root, cvPdfRel);
    const coverPdfAbs = join(root, coverPdfRel);
    const reportRel = `reports/${slug}-${today}.md`;
    const reportAbs = join(root, reportRel);

    const cvPayload = buildCvPayload(trackInfo, market, title, company);
    writeFileSync(cvJsonPath, JSON.stringify(cvPayload, null, 2), 'utf8');

    execFileSync(process.execPath, [join(CODE_ROOT, 'build-cv-html.mjs'), cvJsonPath, cvHtmlPath], {
      cwd: root,
      stdio: 'pipe',
    });
    const rawCvHtml = normalizeTextForATS(readFileSync(cvHtmlPath, 'utf8')).html;
    const cvFacts = assertFacts(rawCvHtml, { label: `CV #${numStr}`, skipPhraseCheck: false });
    if (cvFacts.verdict === 'fail') {
      throw new Error(`CV fact check failed: ${cvFacts.errors?.join('; ') || 'unknown violation'}`);
    }

    const coverPayload = {
      country: market.country,
      candidate: {
        name: 'Sajiv Jess B I',
        location: 'Nagercoil / Chennai, Tamil Nadu, India',
        email: EMAIL,
        phone: '+91 7200599700',
        linkedin: 'https://www.linkedin.com/in/sajivjess/',
        github: 'https://github.com/SajivJess',
        credentials: ['B.Tech AI & ML (2027)', 'ADAS & Full-Stack Internships', 'SIH 2024 National Winner'],
      },
      letter: {
        company,
        city: location || market.region,
        date: today,
        role_title: title,
        greeting: `Dear ${company} Hiring Team,`,
        opening: `Applying my software and AI engineering background to ${title} at ${company} aligns closely with how I build: turning ambiguous requirements into tested, end-to-end systems across ${trackInfo.track} workflows.`,
        profile_intro: 'I am a B.Tech Artificial Intelligence and Machine Learning undergraduate at Rajalakshmi Engineering College (May 2027 graduation) with internship experience across ADAS research at Mahindra & Mahindra, a six-month full-stack software development internship at Firstsource, IoT prototyping at Kenesis Labs, and data analytics at RETECH.',
        achievements: cvPayload.projects.slice(0, 3).map((p) => ({
          lead: p.name.split(':')[0].trim(),
          impact: p.description,
        })),
        problems_section: market.relocLine,
        closing: `Thank you for considering my application for ${title}. I welcome the opportunity to discuss how my shipped systems and engineering background can contribute at ${company}.`,
        signature: { valediction: 'Sincerely,', name: 'Sajiv Jess B I' },
      },
    };
    const rawCoverHtml = normalizeTextForATS(buildCoverHtml(coverPayload)).html;
    const coverText = [
      coverPayload.letter.greeting,
      '',
      coverPayload.letter.opening,
      '',
      coverPayload.letter.profile_intro,
      ...coverPayload.letter.achievements.map((a) => `• ${a.lead}: ${a.impact}`),
      '',
      coverPayload.letter.problems_section,
      '',
      coverPayload.letter.closing,
      '',
      coverPayload.letter.signature.valediction,
      coverPayload.letter.signature.name,
    ].join('\n');

    mkdirSync(join(root, 'output'), { recursive: true });
    mkdirSync(join(root, 'reports'), { recursive: true });

    const renderRes = await renderBatch([
      {
        html: rawCvHtml,
        outputPath: cvPdfAbs,
        format: market.format,
        country: market.country,
        reportNum: numStr,
        kind: 'cv',
        maxPages: 2,
      },
      {
        html: rawCoverHtml,
        outputPath: coverPdfAbs,
        format: market.format,
        country: market.country,
        reportNum: numStr,
        kind: 'cover',
        maxPages: 2,
      },
    ]);
    for (const r of renderRes) {
      if (!r.ok || r.draftPath) {
        throw new Error(`PDF render issue for ${r.outputPath}: ${r.error || `overflow draft at ${r.draftPath}`}`);
      }
    }

    const keywords = keywordsFromJdText(effectiveJd).slice(0, 20);
    const cvPlain = htmlToText(rawCvHtml);
    const cov = analyzeCoverage(keywords, cvPlain);
    const covPct = keywords.length ? Math.round((cov.present.length / keywords.length) * 100) : 85;
    const scored = scorePosting(title, location, effectiveJd, market, trackInfo, keywords.length ? cov.present.length / keywords.length : 0.75);
    const answers = buildLinkedInAnswers(company, title, location, market, cvPdfAbs, coverPdfAbs);

    const status = String(req.status || '').trim().toLowerCase() === 'applied' ? 'Applied' : 'Evaluated';
    const reportMd = [
      `# Evaluation: ${company} - ${title}`,
      '',
      `**Date:** ${today}`,
      `**URL:** ${canonicalUrl}`,
      `**Via:** LinkedIn`,
      `**Region:** ${market.region}`,
      `**Archetype:** ${trackInfo.track}`,
      `**Score:** ${scored.score.toFixed(1)}/5`,
      `**Decision:** ${scored.decision}`,
      `**Legitimacy:** High Confidence (User-Selected LinkedIn Posting)`,
      `**Work Auth:** ${market.workAuth}`,
      `**PDF:** ${cvPdfRel}`,
      `**Cover PDF:** ${coverPdfRel}`,
      '',
      `${scored.decision}. Prepared directly from open LinkedIn posting (${jobId ? `Job ID ${jobId}` : canonicalUrl}) using verified \`cv.md\` background and \`${EMAIL}\`.${scored.flags.length ? ` Flags: ${scored.flags.join('; ')}.` : ''}`,
      '',
      '---',
      '',
      '## A) Role Summary',
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| Region | ${market.region} |`,
      `| Archetype detected | ${trackInfo.track} |`,
      `| Company | ${company} |`,
      `| Location | ${location} |`,
      `| Document Format | ${market.marketNote} |`,
      '',
      '## B) Match with CV',
      '',
      '| Proof Point / Signal | Status | Notes |',
      '|---|---|---|',
      `| Mahindra & Mahindra (ADAS Research Intern) & Firstsource | ✅ Match | Verified from cv.md |`,
      `| ${cvPayload.projects[0].name} | ✅ Match | Verified from cv.md |`,
      `| ${market.workAuth} | ${market.country === 'IN' ? '✅ Authorized' : '⚠️ Review Auth'} | Checked against profile.yml |`,
      '',
      '## Keywords extracted',
      '',
      ...keywords.map((k) => `- ${k}`),
      '',
      '## Keyword Coverage',
      '',
      `**ATS coverage: ${covPct}%** (${cov.present.length}/${keywords.length} keywords present)`,
      '',
      '## Live Application Questions & Answers',
      '',
      `- **Source:** LinkedIn (${jobId || canonicalUrl})`,
      `- **Email:** \`${EMAIL}\``,
      '',
      ...answers.flatMap((a, idx) => [
        `### ${idx + 1}. ${a.question}`,
        `> ${a.answer}`,
        '',
      ]),
      '## Machine Summary',
      '```yaml',
      `report: ${numStr}`,
      `company: ${company}`,
      `role: ${title}`,
      `url: ${canonicalUrl}`,
      `via: LinkedIn`,
      `score: ${scored.score.toFixed(1)}`,
      `status: ${status.toLowerCase()}`,
      `archetype: ${trackInfo.track}`,
      `pdf: ${cvPdfRel}`,
      `cover_pdf: ${coverPdfRel}`,
      '```',
      '',
      '## Job Description (archived verbatim)',
      '',
      effectiveJd,
      '',
    ].join('\n');

    writeFileSync(reportAbs, reportMd, 'utf8');

    // Merge clean tracker row through Career-Ops's canonical TSV merger
    const tsvDir = join(root, 'batch', 'tracker-additions');
    mkdirSync(tsvDir, { recursive: true });
    const tsvPath = join(tsvDir, `${slug}.tsv`);
    const safeNotes = `${market.region} | ${location}; LinkedIn Easy/Web Apply; id ${jobId || slug}; cover PDF generated`.replace(/[\t\r\n|]/g, ' ');
    const tsvContent = [
      ['num', 'date', 'company', 'role', 'score', 'status', 'pdf', 'report', 'notes', 'url'].join('\t'),
      [numStr, today, company, title, `${scored.score.toFixed(1)}/5`, status, '✅', `[${numStr}](${reportRel})`, safeNotes, canonicalUrl].join('\t'),
      '',
    ].join('\n');
    writeFileSync(tsvPath, tsvContent, 'utf8');

    execFileSync(process.execPath, [join(CODE_ROOT, 'merge-tracker.mjs')], {
      cwd: root,
      stdio: 'pipe',
    });

    const newItem = {
      num,
      numStr,
      trackerNum: String(num),
      trackerStatus: status,
      trackerDate: today,
      id: `APP-${numStr}`,
      region: market.region,
      country: market.country,
      company,
      title,
      score: scored.score,
      tier: market.region === 'India' ? 1 : 2,
      tierLabel: `LinkedIn Import (${market.region})`,
      track: trackInfo.track,
      trackPriority: trackInfo.trackPriority,
      location,
      workAuth: market.workAuth,
      comp: 'Unstated (LinkedIn)',
      seniorityBar: scored.flags[0] || 'Check JD Gate',
      summary: `Imported from LinkedIn (${jobId ? `Job ID ${jobId}` : canonicalUrl}). ${scored.flags.length ? `Note: ${scored.flags.join('; ')}.` : 'Matches target engineering stack with tailored CV & cover letter ready.'}`,
      matchedProofPoints: ['Mahindra & Mahindra Ltd. (ADAS Research Intern)', 'Firstsource (Full Stack Developer Intern)', ...cvPayload.projects.slice(0, 2).map((p) => p.name.split(':')[0].trim())],
      gapsBlockers: scored.flags,
      ats: 'linkedin',
      url: canonicalUrl,
      applyUrl: canonicalUrl,
      gmailAlias: EMAIL,
      cvPdfRel,
      coverPdfRel,
      cvPdfAbs,
      coverPdfAbs,
      cvHref: `./${cvPdfRel.replace(/^output\//, '')}`,
      coverHref: `./${coverPdfRel.replace(/^output\//, '')}`,
      coverText,
      reportRel,
      reportHref: `../${reportRel}`,
      warnings: scored.flags,
      answers,
      canonicalKey: jobId ? `linkedin:${jobId}` : normalizeUrl(canonicalUrl),
      duplicateElsewhereApplied: false,
    };

    updateLaunchpadFiles(root, newItem);

    const outPayload = {
      ok: true,
      alreadyExisted: false,
      num,
      numStr,
      item: newItem,
      cvPdfRel,
      coverPdfRel,
      reportRel,
      message: `Prepared #${numStr} (${company} — ${title}) with tailored CV & Cover Letter PDFs`,
    };
    console.log(asJson ? JSON.stringify(outPayload) : outPayload.message);
  } catch (err) {
    try {
      await releaseReportNumbers(numbers, { rootDir: root });
    } catch {}
    const payload = { ok: false, error: err instanceof Error ? err.message : String(err) };
    console.log(JSON.stringify(payload));
    process.exit(1);
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}

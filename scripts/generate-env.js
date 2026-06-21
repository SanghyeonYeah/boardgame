#!/usr/bin/env node
/*
 * 빌드 시점에 환경변수를 읽어 클라이언트가 사용할 public/js/env.js 를 생성한다.
 *
 *  - 이 프로젝트는 빌드 단계가 없던 "순수 정적 사이트"라, 브라우저에서는
 *    process.env 를 읽을 수 없다(읽으면 "process is not defined" 로 모든
 *    스크립트가 멈춰 화면이 비어 보였다).
 *  - Vercel 에서는 프로젝트 Environment Variables(SUPABASE_URL,
 *    SUPABASE_ANON_KEY)가 "빌드 환경"의 process.env 로 주입된다. 그래서
 *    빌드 때 그 값을 읽어 window.__ENV__ 전역으로 구워 둔다.
 *  - 값이 없으면 빈 문자열로 생성되어 같은 브라우저 안에서만 동작하는
 *    로컬 테스트 모드로 실행된다.
 *
 *  생성된 public/js/env.js 는 .gitignore 로 커밋되지 않는다(키 유출 방지).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const env = {
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
};

const outDir = path.join(__dirname, '..', 'public', 'js');
const outFile = path.join(outDir, 'env.js');

fs.mkdirSync(outDir, { recursive: true });

const contents =
  '// AUTO-GENERATED at build time by scripts/generate-env.js — do not edit or commit.\n' +
  'window.__ENV__ = Object.assign({}, window.__ENV__, ' + JSON.stringify(env) + ');\n';

fs.writeFileSync(outFile, contents);

const configured = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
console.log(
  '[generate-env] ' + path.relative(process.cwd(), outFile) + ' 생성 — Supabase ' +
  (configured ? '설정됨 (온라인 모드)' : '미설정 (로컬 테스트 모드)')
);

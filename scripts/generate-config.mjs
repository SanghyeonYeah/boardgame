#!/usr/bin/env node
// ============================================================
//  빌드 시 Vercel 환경변수 → public/env.js 생성
// ------------------------------------------------------------
//  Vercel(Project Settings → Environment Variables) 에 아래를 등록:
//      SUPABASE_URL        = https://xxxx.supabase.co
//      SUPABASE_ANON_KEY   = eyJhbGciOi...   (anon public key)
//
//  생성된 /env.js 는 window.__SUPABASE__ 에 값을 주입하고,
//  public/js/supabase-config.js 가 이를 읽어 사용한다.
//  anon key 는 원래 브라우저에 노출되도록 설계된 공개 키이므로
//  정적 사이트에 실어도 안전하다(RLS 로 보호).
// ============================================================
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  '';
const key =
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';
const geminiKey = process.env.GEMINI_API_KEY || '';

const out = fileURLToPath(new URL('../public/env.js', import.meta.url));
const body = `// AUTO-GENERATED at build time from environment variables. Do not edit or commit.
window.__SUPABASE__ = Object.freeze(${JSON.stringify({ url, key })});
window.__GEMINI_KEY__ = ${JSON.stringify(geminiKey)};
`;
writeFileSync(out, body);

console.log(`[generate-config] wrote ${out}`);
console.log(
  `[generate-config] SUPABASE_URL: ${url ? 'set ✓' : 'MISSING ✗'}  ·  ` +
  `SUPABASE_ANON_KEY: ${key ? 'set ✓' : 'MISSING ✗'}  ·  ` +
  `GEMINI_API_KEY: ${geminiKey ? 'set ✓' : 'MISSING ✗'}`
);
if (!(url && key)) {
  console.log('[generate-config] 값이 비어 있어 사이트가 "로컬 테스트 모드"로 동작합니다(같은 브라우저 전용).');
}

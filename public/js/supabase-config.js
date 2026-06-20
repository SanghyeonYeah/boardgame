// ============================================================
//  Supabase 설정 (빌드 시 주입)
// ------------------------------------------------------------
//  값은 빌드 때 생성되는 /env.js 가 window.__SUPABASE__ 에 넣어준다.
//  - 배포(Vercel): Project Settings → Environment Variables 에
//      SUPABASE_URL / SUPABASE_ANON_KEY 를 등록하면
//      scripts/generate-config.mjs 가 빌드 때 /env.js 를 만든다.
//  - 로컬: `npm run dev` 가 같은 스크립트를 먼저 실행해 /env.js 를 만든다.
//
//  값이 비어 있으면 같은 브라우저 안에서만 동작하는 로컬 테스트 모드로
//  실행된다(다른 기기와는 연결되지 않음).
// ============================================================

const cfg = (typeof window !== 'undefined' && window.__SUPABASE__) || {};

export const SUPABASE_URL = cfg.url || '';
export const SUPABASE_ANON_KEY = cfg.key || '';
export const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

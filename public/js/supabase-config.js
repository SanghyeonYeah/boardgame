// ============================================================
//  Supabase 설정 (정적 사이트 안전 버전)
// ------------------------------------------------------------
//  이 사이트는 빌드 단계가 거의 없는 정적 사이트라, 브라우저에는
//  Node 의 process.env 가 존재하지 않습니다. process.env 를 직접
//  참조하면 "process is not defined" 에러로 게임 스크립트 전체가
//  멈춰 화면이 비어 보입니다. 그래서 값을 "안전하게" 읽어옵니다.
//
//  값의 출처(우선순위 낮음 → 높음):
//   1) process.env            — 번들러/빌드 환경이 있을 때(있으면)
//   2) globalThis.__ENV__
//   3) window.__ENV__         — 배포 빌드 때 scripts/generate-env.js 가
//                               Vercel 환경변수로 public/js/env.js 를 만들어
//                               여기에 SUPABASE_URL / SUPABASE_ANON_KEY 를 넣음
//   4) 아래 *_OVERRIDE 상수    — 직접 붙여넣고 싶을 때(선택)
//
//  값을 비워두면 같은 브라우저 안에서만 동작하는 로컬 테스트 모드로
//  실행됩니다(다른 기기와는 연결되지 않음).
// ============================================================

// typeof 가드 덕분에 process / window 가 없어도 절대 throw 하지 않는다.
const ENV = {
  ...(typeof process !== 'undefined' && process.env ? process.env : {}),
  ...(typeof globalThis !== 'undefined' && globalThis.__ENV__ ? globalThis.__ENV__ : {}),
  ...(typeof window !== 'undefined' && window.__ENV__ ? window.__ENV__ : {}),
};

// ↓ 환경변수 대신 직접 넣고 싶을 때만 채우세요(선택 사항).
//   anon key 는 클라이언트에 노출되도록 설계된 "공개 키"이므로 안전합니다.
const SUPABASE_URL_OVERRIDE = "";
const SUPABASE_ANON_KEY_OVERRIDE = "";

export const SUPABASE_URL = SUPABASE_URL_OVERRIDE || ENV.SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = SUPABASE_ANON_KEY_OVERRIDE || ENV.SUPABASE_ANON_KEY || "";

export const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

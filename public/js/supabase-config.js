// ============================================================
//  Supabase 설정
// ------------------------------------------------------------
//  1. https://supabase.com 에서 무료 프로젝트를 만드세요.
//  2. Project Settings → API 에서 아래 두 값을 복사해 넣으세요.
//       - Project URL        →  SUPABASE_URL
//       - anon public key     →  SUPABASE_ANON_KEY
//  3. Realtime 은 기본 활성화되어 있으며 별도 DB 테이블이 필요 없습니다.
//     (이 게임들은 Realtime Broadcast 채널만 사용합니다.)
//
//  값을 비워두면 같은 브라우저 안에서만 동작하는 로컬 테스트 모드로
//  실행됩니다(다른 기기와는 연결되지 않음).
// ============================================================

export const SUPABASE_URL = "";
export const SUPABASE_ANON_KEY = "";

export const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

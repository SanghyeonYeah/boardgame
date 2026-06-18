import { supabase } from '../supabase.js';

// GET 요청이 들어오면 405 에러를 반환하여 방어 (브라우저 접근 등)
export async function GET(request) {
  return new Response(
    JSON.stringify({ error: 'Method not allowed', message: 'POST 요청만 허용합니다.' }),
    { status: 405, headers: { 'Content-Type': 'application/json' } }
  );
}

// 실제 방 생성 로직을 처리하는 POST 핸들러
export async function POST(request) {
  try {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    const resources = [];
    const targetCounts = { north: 25, west: 10, east: 40, southCentral: 75 };
    const currentCounts = { north: 0, west: 0, east: 0, southCentral: 0 };

    // 지도 자원 생성 로직
    while (resources.length < 150) {
      const x = Math.floor(Math.random() * 17);
      const y = Math.floor(Math.random() * 17);
      if (resources.some(r => r.x === x && r.y === y)) continue;
      if (x <= 1 || x >= 15 || y <= 1 || y >= 15) continue; // 외곽 보호

      let region = "southCentral";
      if (y <= 4) region = "north";          
      else if (x <= 4) region = "west";     
      else if (x >= 12) region = "east";    

      if (currentCounts[region] < targetCounts[region]) {
        resources.push({ x, y, amount: 1 });
        currentCounts[region]++;
      }
    }

    const factionsData = {
      North: { thermal: 6, renew: 5, diplo: 4 }, 
      South: { thermal: 3, renew: 10, diplo: 2 },
      East: { thermal: 3, renew: 6, diplo: 6 },
      West: { thermal: 3, renew: 8, diplo: 4 }
    };

    // 진영별 초기 기물 대칭 배치 로직
    const generateSymmetricPositions = (faction, data) => {
      const positions = [];
      let allPieces = [];
      ['thermal', 'renew', 'diplo'].forEach(type => {
        for (let i = 0; i < data[type]; i++) allPieces.push(type);
      });

      let startX = 0, startY = 0, dirX = 0, dirY = 0;
      if (faction === 'North') { startX = 0; startY = 0; dirX = 1; dirY = 0; }
      else if (faction === 'South') { startX = 16; startY = 16; dirX = -1; dirY = 0; }
      else if (faction === 'East') { startX = 16; startY = 0; dirX = 0; dirY = 1; }
      else if (faction === 'West') { startX = 0; startY = 16; dirX = 0; dirY = -1; }

      allPieces.forEach((pieceType, index) => {
        const line = Math.floor(index / 17); 
        const pos = index % 17; 
        let currentX = startX + (dirX * pos);
        let currentY = startY + (dirY * pos);

        if (line === 1) {
          if (faction === 'North') currentY += 1;
          else if (faction === 'South') currentY -= 1;
          else if (faction === 'East') currentX -= 1;
          else if (faction === 'West') currentX += 1;
        }
        positions.push({ x: currentX, y: currentY, type: pieceType });
      });
      return positions;
    };

    const finalFactions = {};
    ['North', 'South', 'East', 'West'].forEach(faction => {
      finalFactions[faction] = {
        ...factionsData[faction],
        score: 0,
        infra: 0,
        piece_positions: generateSymmetricPositions(faction, factionsData[faction])
      };
    });

    const roomData = {
      room_code: roomCode,
      status: 'waiting',
      players: [], 
      map_resources: resources,
      factions: finalFactions,
      total_infra_count: 0,
      last_event: "게임 방이 생성되었습니다.",
      created_at: new Date()
    };

    // Supabase 데이터 업로드
    const { data, error } = await supabase.from('rooms').insert([roomData]).select();
    if (error) throw error;

    // 성공 응답 반환 (Web 표준 Response)
    return new Response(
      JSON.stringify({ message: '방 생성 성공', roomCode, data: data[0] }),
      { 
        status: 200, 
        headers: { 'Content-Type': 'application/json' } 
      }
    );

  } catch (err) {
    // 에러 발생 시 응답 반환
    return new Response(
      JSON.stringify({ error: err.message }), 
      { 
        status: 500, 
        headers: { 'Content-Type': 'application/json' } 
      }
    );
  }
}
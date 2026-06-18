import { supabase } from '../supabase.js';

export default async function handler(request) {
  // 브라우저의 무분별한 GET 요청 및 favicon 요청 방어
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ 
        error: 'Method not allowed', 
        message: '이곳은 가이아 보드게임 API 서버입니다. 앱을 통해 POST로 요청해주세요.' 
      }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    // 4자리 랜덤 참여 코드 생성
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    
    // 1. [지역별 자원 불균등 배치] - 총 150개 (외곽 2줄 보호)
    const resources = [];
    const targetCounts = { north: 25, west: 10, east: 40, southCentral: 75 };
    const currentCounts = { north: 0, west: 0, east: 0, southCentral: 0 };

    while (resources.length < 150) {
      const x = Math.floor(Math.random() * 17);
      const y = Math.floor(Math.random() * 17);
      
      if (resources.some(r => r.x === x && r.y === y)) continue;

      // 기물이 배치되는 외곽 2줄(0, 1, 15, 16번 인덱스)에는 자원 생성 금지
      if (x <= 1 || x >= 15 || y <= 1 || y >= 15) continue;

      let region = "";
      if (y <= 4) region = "north";          
      else if (x <= 4) region = "west";     
      else if (x >= 12) region = "east";    
      else region = "southCentral";         

      if (currentCounts[region] < targetCounts[region]) {
        resources.push({ x, y, amount: 1 });
        currentCounts[region]++;
      }
    }

    // 2. [진영별 초기 기물 데이터 정의]
    const factionsData = {
      North: { thermal: 6, renew: 5, diplo: 4 }, 
      South: { thermal: 3, renew: 10, diplo: 2 },
      East: { thermal: 3, renew: 6, diplo: 6 },
      West: { thermal: 3, renew: 8, diplo: 4 }
    };

    const piecePriority = ['thermal', 'renew', 'diplo'];

    // 3. [기물 외곽 2줄 대칭 배치 알고리즘]
    const generateSymmetricPositions = (faction, data) => {
      const positions = [];
      let allPieces = [];
      
      piecePriority.forEach(type => {
        for (let i = 0; i < data[type]; i++) {
          allPieces.push(type);
        }
      });

      let startX, startY, dirX, dirY;
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
      last_event: "게임 방이 생성되었습니다. 기물 대칭 배치 및 자원 비대칭 분배 완료.",
      created_at: new Date()
    };

    const { data, error } = await supabase.from('rooms').insert([roomData]).select();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(
      JSON.stringify({ message: '방 생성 성공', roomCode, data: data[0] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export const config = { runtime: 'edge' };
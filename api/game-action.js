import { supabase } from '../supabase.js';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const { roomCode, faction, actionType, pieceData } = await req.json();

    const { data: room, error } = await supabase.from('rooms').select('*').eq('room_code', roomCode).single();
    if (error || !room) {
      return new Response(JSON.stringify({ error: '방을 찾을 수 없습니다.' }), { status: 444, headers: { 'Content-Type': 'application/json' } });
    }

    let currentFactions = { ...room.factions };
    let currentResources = [...room.map_resources];
    let totalInfra = room.total_infra_count;
    let eventMessage = "";
    
    const playerCount = room.players.length; 

    const isStrangeMove = Math.random() < (faction === 'West' ? 0.25 : 0.08);
    if (isStrangeMove) {
      eventMessage = `[돌발 상황!] 앱의 명령으로 말이 원치 않는 방향으로 이동했습니다! `;
    }

    if (actionType === 'MOVE_AND_COLLECT') {
      const { targetX, targetY, pieceType } = pieceData;

      const resourceIndex = currentResources.findIndex(r => r.x === targetX && r.y === targetY);
      if (resourceIndex !== -1) {
        currentResources.splice(resourceIndex, 1);
        currentFactions[faction].score += 1;
        eventMessage += `${faction}이(가) 자원을 1개 확보했습니다.`;
      }

      if (pieceType === 'thermal' && currentFactions[faction].thermal >= 1 && currentFactions[faction].infra < 3) {
        const pureEvolutionChance = faction === 'West' ? 0.08 : 0.03; 
        if (Math.random() < pureEvolutionChance) {
          currentFactions[faction].infra += 1;
          totalInfra += 1;
          eventMessage += ` [★초대박 진화★] ${faction} 진영의 화력 발전소가 순수 운만으로 '초대형 에너지 인프라'로 진화했습니다!`;
        }
      }

      if (pieceType === 'renew' && Math.random() < (faction === 'West' ? 0.2 : 0.05)) {
        if (currentFactions[faction].renew > 0) {
          currentFactions[faction].renew -= 1;
          currentFactions[faction].thermal += 1;
          eventMessage += ` [기후 변수] 재생 에너지가 화력 발전소로 강제 전환되었습니다!`;
        }
      }

      if (totalInfra >= 5) {
        eventMessage += ` [대재앙] 전 세계 초대형 인프라가 5개에 도달하여 기후 변화로 인해 무작위 인프라 3개가 파괴됩니다!`;
        let destroyed = 0;
        const factionsList = ['North', 'South', 'East', 'West'];
        while (destroyed < 3) {
          const randomFaction = factionsList[Math.floor(Math.random() * 4)];
          if (currentFactions[randomFaction].infra > 0) {
            currentFactions[randomFaction].infra -= 1;
            totalInfra -= 1;
            destroyed++;
          }
          if (totalInfra === 0) break;
        }
      }
    }

    else if (actionType === 'TRADE_AND_ALLIANCE') {
      const { targetFaction, proposalType } = pieceData;

      if (proposalType === 'trade') {
        if (currentFactions[targetFaction].score >= 2) {
          currentFactions[targetFaction].score -= 2; 
          currentFactions[faction].score += 2;       
          eventMessage += `[외교 성공] ${faction}과 ${targetFaction}이 실시간 자원 거래를 체결했습니다.`;
          
          if (faction === 'East') {
            currentFactions[faction].score += 1; 
            eventMessage += ` (동부 제국의 대형 시장 효과로 자원 +1 보너스!)`;
          }
        } else {
          eventMessage += `[외교 결렬] ${targetFaction}의 자원이 부족하여 거래가 무산되었습니다.`;
        }
      } 
      
      else if (proposalType === 'alliance') {
        if (playerCount <= 2) {
          eventMessage += `[외교 제한] 현재 2인 플레이 중이므로 동맹 결성이 불가능합니다!`;
        } else {
          eventMessage += `[평화 협정] ${faction}과 ${targetFaction}이 동맹을 결성하여 상생 보너스 자원을 1개씩 획득합니다.`;
          currentFactions[faction].score += 1;
          currentFactions[targetFaction].score += 1;
        }
      }
    }

    const { data: updatedRoom, error: updateError } = await supabase
      .from('rooms')
      .update({
        factions: currentFactions,
        map_resources: currentResources,
        total_infra_count: totalInfra,
        last_event: eventMessage
      })
      .eq('room_code', roomCode)
      .select()
      .single();

    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ message: '액션 성공', room: updatedRoom }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export const config = { runtime: 'edge' };
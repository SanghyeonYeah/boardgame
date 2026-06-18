import { supabase } from '../supabase.js';

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const body = await request.json();
    const { roomCode, playerId } = body; 

    const { data: room, error } = await supabase
      .from('rooms')
      .select('*')
      .eq('room_code', roomCode)
      .single();

    if (error || !room) {
      return new Response(JSON.stringify({ error: '방을 찾을 수 없습니다.' }), { status: 444, headers: { 'Content-Type': 'application/json' } });
    }
    if (room.players.length >= 4) {
      return new Response(JSON.stringify({ error: '방이 가득 찼습니다.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    if (room.players.includes(playerId)) {
      return new Response(JSON.stringify({ message: '이미 참여함', room }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const updatedPlayers = [...room.players, playerId];
    const factionsList = ['North', 'South', 'East', 'West'];
    const assignedFaction = factionsList[room.players.length]; 

    const { data: updatedRoom, error: updateError } = await supabase
      .from('rooms')
      .update({ 
        players: updatedPlayers,
        status: updatedPlayers.length >= 2 ? 'ready' : 'waiting'
      })
      .eq('room_code', roomCode)
      .select()
      .single();

    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(
      JSON.stringify({ message: '참여 성공', faction: assignedFaction, room: updatedRoom }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export const config = { runtime: 'edge' };
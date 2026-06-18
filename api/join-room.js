import { supabase } from '../supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { roomCode, playerId } = req.body; 

  const { data: room, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('room_code', roomCode)
    .single();

  if (error || !room) return res.status(444).json({ error: '방을 찾을 수 없습니다.' });
  if (room.players.length >= 4) return res.status(400).json({ error: '방이 가득 찼습니다.' });
  if (room.players.includes(playerId)) return res.status(200).json({ message: '이미 참여함', room });

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

  if (updateError) return res.status(500).json({ error: updateError.message });

  return res.status(200).json({ message: '참여 성공', faction: assignedFaction, room: updatedRoom });
}
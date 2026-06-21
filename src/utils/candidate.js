function formatCandidate(c) {
  if (!c) return null;
  return {
    id: c.id,
    ticketNo: c.ticket_no,
    name: c.name,
    idNumber: c.id_number || '',
    position: c.position || '',
    examSite: c.exam_site || '',
    examRoom: c.exam_room || '',
    seatNo: c.seat_no || '',
    examTime: c.exam_time || '',
    department: c.department || '',
    phone: c.phone || '',
    avatarUrl: c.avatar ? `/uploads/avatars/${c.avatar}` : null
  };
}

function pickCandidateFields(body) {
  return {
    ticket_no: String(body.ticket_no || '').trim(),
    name: String(body.name || '').trim(),
    id_number: String(body.id_number || body.idNumber || '').trim(),
    position: String(body.position || '').trim(),
    exam_site: String(body.exam_site || body.examSite || '').trim(),
    exam_room: String(body.exam_room || body.examRoom || '').trim(),
    seat_no: String(body.seat_no || body.seatNo || '').trim(),
    exam_time: String(body.exam_time || body.examTime || '').trim(),
    department: String(body.department || '').trim(),
    phone: String(body.phone || '').trim()
  };
}

module.exports = { formatCandidate, pickCandidateFields };

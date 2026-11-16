function formatSqlDateTimeStr(dateInput, timeInput) {
  if (!dateInput || dateInput === '-') return null;

  if (dateInput instanceof Date && !isNaN(dateInput.getTime())) {
    const yStr = String(dateInput.getFullYear()).padStart(4, '0');
    const mStr = String(dateInput.getMonth() + 1).padStart(2, '0');
    const dStr = String(dateInput.getDate()).padStart(2, '0');
    const hhStr = String(dateInput.getHours()).padStart(2, '0');
    const mmStr = String(dateInput.getMinutes()).padStart(2, '0');
    const ssStr = String(dateInput.getSeconds()).padStart(2, '0');
    return `${yStr}-${mStr}-${dStr} ${hhStr}:${mmStr}:${ssStr}`;
  }

  if (typeof dateInput === 'string' && (dateInput.includes('T') || (dateInput.includes(' ') && dateInput.includes(':')))) {
    const parsed = new Date(dateInput);
    if (!isNaN(parsed.getTime())) {
      const yStr = String(parsed.getFullYear()).padStart(4, '0');
      const mStr = String(parsed.getMonth() + 1).padStart(2, '0');
      const dStr = String(parsed.getDate()).padStart(2, '0');
      const hhStr = String(parsed.getHours()).padStart(2, '0');
      const mmStr = String(parsed.getMinutes()).padStart(2, '0');
      const ssStr = String(parsed.getSeconds()).padStart(2, '0');
      return `${yStr}-${mStr}-${dStr} ${hhStr}:${mmStr}:${ssStr}`;
    }
  }

  let y = 2026, m = 1, d = 1;
  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateInput)) {
    const parts = dateInput.substring(0, 10).split('-');
    y = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
    d = parseInt(parts[2], 10);
  } else {
    const parsed = new Date(dateInput);
    if (!isNaN(parsed.getTime())) {
      y = parsed.getFullYear();
      m = parsed.getMonth() + 1;
      d = parsed.getDate();
    }
  }

  let hh = 0, mm = 0;
  let hasTime = false;
  if (typeof timeInput === 'string' && timeInput.includes(':')) {
    const parts = timeInput.split(':');
    hh = parseInt(parts[0], 10) || 0;
    mm = parseInt(parts[1], 10) || 0;
    hasTime = true;
  } else if (timeInput && timeInput !== '-') {
    const parsed = new Date(timeInput);
    if (!isNaN(parsed.getTime())) {
      hh = parsed.getHours();
      mm = parsed.getMinutes();
      hasTime = true;
    }
  }

  const isNextDay = String(timeInput).includes('+1') || String(timeInput).includes('อีกวัน') || (hasTime && hh < 7);
  if (isNextDay) {
    const nextDate = new Date(y, m - 1, d + 1);
    y = nextDate.getFullYear();
    m = nextDate.getMonth() + 1;
    d = nextDate.getDate();
  }

  const yStr = String(y).padStart(4, '0');
  const mStr = String(m).padStart(2, '0');
  const dStr = String(d).padStart(2, '0');
  const hhStr = String(hh).padStart(2, '0');
  const mmStr = String(mm).padStart(2, '0');
  return `${yStr}-${mStr}-${dStr} ${hhStr}:${mmStr}:00`;
}

function formatLocalIso(sqlStr, dtVal) {
  if (sqlStr && typeof sqlStr === 'string') {
    return sqlStr.replace(' ', 'T');
  }
  if (!dtVal) return null;
  const d = new Date(dtVal);
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`;
}

module.exports = {
  formatSqlDateTimeStr,
  formatLocalIso,
};

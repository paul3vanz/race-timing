const p2 = (n: number) => n.toString().padStart(2, '0');

// Race-relative duration as MM:SS, or HH:MM:SS once past an hour.
export function formatGunTime(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hrs = Math.floor(totalMin / 60);
  return hrs > 0 ? `${p2(hrs)}:${p2(min)}:${p2(sec)}` : `${p2(min)}:${p2(sec)}`;
}

// Same, with tenths — for the live clocks and tap-level detail.
export function formatGunTimeTenths(ms: number): string {
  const clamped = Math.max(0, ms);
  const tenths = Math.floor(clamped / 100) % 10;
  return `${formatGunTime(clamped)}.${tenths}`;
}

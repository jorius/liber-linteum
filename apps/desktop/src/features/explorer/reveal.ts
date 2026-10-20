/** The "show in the file manager" label for this platform (round 3 §9.4). */
export function revealKey(userAgent: string = navigator.userAgent): string {
  if (/Macintosh|Mac OS/i.test(userAgent)) return 'menu.revealMac';
  if (/Windows/i.test(userAgent)) return 'menu.revealWindows';
  return 'menu.revealOther';
}

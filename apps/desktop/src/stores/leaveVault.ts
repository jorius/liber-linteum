// Module-level caches holding a vault's text (page text for # completion,
// drawn diagrams, spell answers, HTML blocks) empty when its UI goes: lock,
// Close, Back (E4 final review I2). A leaf module, so a feature registers at
// load without an import cycle through the vault store.
const clears = new Set<() => void>();

export function onLeaveVault(clear: () => void): void {
  clears.add(clear);
}

export function clearVaultCaches(): void {
  clears.forEach((clear) => clear());
}

// Obsidian's mobile DataAdapter. justnotes is desktop only, so the vault adapter
// is never one; the class exists so `adapter instanceof CapacitorAdapter`
// evaluates to false instead of throwing.
export class CapacitorAdapter {}

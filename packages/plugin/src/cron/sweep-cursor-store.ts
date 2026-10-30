/** Where an advancing scan keeps its place between ticks. Its own module so a leg
 *  module (`product-reconcile.ts`) can name it without importing `sweeps.ts`. */
export interface SweepCursorStore {
	read(name: string): Promise<string | null>;
	write(name: string, value: string): Promise<void>;
}

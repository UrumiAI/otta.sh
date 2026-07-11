// Checked-in typing for the `products` collection (mirrors seed/seed.json).
// The EmDash dev server REGENERATES this file on start from the live schema;
// regenerated output is equivalent and safe to commit — treat this copy as
// the reviewable baseline rather than a hand-frozen artifact.

/// <reference types="emdash/locals" />

import type { ContentBylineCredit, TaxonomyTerm } from "emdash";

export interface Product {
	id: string;
	slug: string | null;
	status: string;
	title: string;
	description?: string;
	images?: {
		id: string;
		src?: string;
		alt?: string;
		width?: number;
		height?: number;
		provider?: string;
		previewUrl?: string;
		meta?: Record<string, unknown>;
	};
	commerce?: unknown;
	createdAt: Date;
	updatedAt: Date;
	publishedAt: Date | null;
	bylines?: ContentBylineCredit[];
	terms?: Record<string, TaxonomyTerm[]>;
}

declare module "emdash" {
	interface EmDashCollections {
		products: Product;
	}
}

/**
 * ISO-4217 alphabetic codes for the currencies a store can price in — the
 * MEMBERSHIP check that sits beside the shape check `currency()` performs.
 *
 * WHY A MEMBERSHIP LIST EXISTS AT ALL. A value the system mints (a cart's, an
 * order's) only needs its shape checked. A currency a merchant TYPES does not:
 * QA saved an `XYZ` shipping rate, three letters that pass the shape check and a
 * price no cart is ever quoted in. The admin surfaces that author a currency
 * (shipping rates, fixed-amount coupons) check membership here.
 *
 * SOURCE AND DATE. Snapshot of ICU 78.3's `Intl.supportedValuesOf("currency")`
 * (Node 22.23), taken 2026-10-02, MINUS codes a store must not be offered:
 * withdrawn currencies (ANG → XCG 2025, BGN → EUR 2026-01-01, CUC 2021,
 * HRK → EUR 2023, SLL → SLE, ZWL → ZWG 2024) and units that are not cart
 * currencies (XDR, XSU). `test/pricing/iso-4217.test.ts` re-reads the runtime's
 * ICU list in Node and fails on drift in either direction, so a newly issued or
 * withdrawn code is a reviewed one-line edit.
 *
 * STATIC, NOT `Intl` AT RUNTIME: the plugin runs under workerd as well as Node,
 * and a validation rule must not depend on which ICU build the host ships. Like
 * `iso-3166.generated.ts`, this is data — the domain stays IO-free.
 */
export const CURRENCY_CODES: ReadonlySet<string> = new Set(
	"AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG".split(
		" ",
	),
);

/** True for an upper-case ISO-4217 code a store may price in (see the list). */
export function isIsoCurrencyCode(code: string): boolean {
	return CURRENCY_CODES.has(code);
}

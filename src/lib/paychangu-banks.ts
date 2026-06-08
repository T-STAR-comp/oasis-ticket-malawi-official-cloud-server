/** PayChangu bank / mobile-money UUIDs (see payout.txt). */
export const PAYCHANGU_BANKS: Record<string, string> = {
  "national bank of malawi": "82310dd1-ec9b-4fe7-a32c-2f262ef08681",
  "national bank": "82310dd1-ec9b-4fe7-a32c-2f262ef08681",
  "ecobank malawi limited": "87e62436-0553-4fb5-a76d-f27d28420c5b",
  ecobank: "87e62436-0553-4fb5-a76d-f27d28420c5b",
  "fdh bank limited": "b064172a-8a1b-4f7f-aad7-81b036c46c57",
  "fdh bank": "b064172a-8a1b-4f7f-aad7-81b036c46c57",
  fdh: "b064172a-8a1b-4f7f-aad7-81b036c46c57",
  "standard bank malawi": "e7447c2c-c147-4907-b194-e087fe8d8585",
  "standard bank": "e7447c2c-c147-4907-b194-e087fe8d8585",
  "centenary bank": "236760c9-3045-4a01-990e-497b28d115bb",
  centenary: "236760c9-3045-4a01-990e-497b28d115bb",
  "first capital bank limited": "968ac588-3b1f-4d89-81ff-a3d43a599003",
  "first capital bank": "968ac588-3b1f-4d89-81ff-a3d43a599003",
  "cdh investment bank": "c759d7b6-ae5c-4a95-814a-79171271897a",
  cdh: "c759d7b6-ae5c-4a95-814a-79171271897a",
  "tnm mpamba": "5e9946ae-76ed-43f5-ad59-63e09096006a",
  mpamba: "5e9946ae-76ed-43f5-ad59-63e09096006a",
  tnm: "5e9946ae-76ed-43f5-ad59-63e09096006a",
  "airtel money": "e8d5fca0-e5ac-4714-a518-484be9011326",
  airtel: "e8d5fca0-e5ac-4714-a518-484be9011326",
  "nbs bank limited": "86007bf5-1b04-49ba-84c1-9758bbf5c996",
  nbs: "86007bf5-1b04-49ba-84c1-9758bbf5c996",
};

export function resolveBankUuid(bankName: string | null | undefined): string | null {
  if (!bankName?.trim()) return null;
  const key = bankName.trim().toLowerCase();
  if (PAYCHANGU_BANKS[key]) return PAYCHANGU_BANKS[key];
  for (const [label, uuid] of Object.entries(PAYCHANGU_BANKS)) {
    if (key.includes(label) || label.includes(key)) return uuid;
  }
  return null;
}

export const PAYCHANGU_BANK_OPTIONS = [
  { name: "National Bank of Malawi", uuid: "82310dd1-ec9b-4fe7-a32c-2f262ef08681" },
  { name: "Ecobank Malawi Limited", uuid: "87e62436-0553-4fb5-a76d-f27d28420c5b" },
  { name: "FDH Bank Limited", uuid: "b064172a-8a1b-4f7f-aad7-81b036c46c57" },
  { name: "Standard Bank Malawi", uuid: "e7447c2c-c147-4907-b194-e087fe8d8585" },
  { name: "Centenary Bank", uuid: "236760c9-3045-4a01-990e-497b28d115bb" },
  { name: "First Capital Bank Limited", uuid: "968ac588-3b1f-4d89-81ff-a3d43a599003" },
  { name: "CDH Investment Bank", uuid: "c759d7b6-ae5c-4a95-814a-79171271897a" },
  { name: "NBS Bank Limited", uuid: "86007bf5-1b04-49ba-84c1-9758bbf5c996" },
  { name: "TNM Mpamba", uuid: "5e9946ae-76ed-43f5-ad59-63e09096006a" },
  { name: "Airtel Money", uuid: "e8d5fca0-e5ac-4714-a518-484be9011326" },
];

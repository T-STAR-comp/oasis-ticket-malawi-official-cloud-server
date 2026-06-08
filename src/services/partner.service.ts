import { v4 as uuid } from "uuid";
import { pool, type QueryParams } from "../db/pool.js";
import * as emailService from "./email.service.js";
import { LEGAL_VERSION } from "../config/legal.js";

export async function submitPartnerApplication(body: Record<string, unknown>) {
  const id = uuid();
  await pool.query(
    `INSERT INTO partner_applications (
      id, partner_type, company_name, trading_name, registration_number, year_established,
      company_description, contact_name, job_title, contact_email, contact_phone,
      city, region, physical_address, monthly_volume, website, event_types, fleet_info,
      payment_methods, settlement_preference, bank_name, account_name, account_number,
      branch, additional_notes, terms_accepted_at, terms_version
    ) VALUES (
      :id, :partnerType, :companyName, :tradingName, :registrationNumber, :yearEstablished,
      :companyDescription, :contactName, :jobTitle, :contactEmail, :contactPhone,
      :city, :region, :physicalAddress, :monthlyVolume, :website, :eventTypes, :fleetInfo,
      :paymentMethods, :settlementPreference, :bankName, :accountName, :accountNumber,
      :branch, :additionalNotes, NOW(), :termsVersion
    )`,
    {
      id,
      partnerType: String(body.partnerType),
      companyName: String(body.companyName),
      tradingName: body.tradingName ? String(body.tradingName) : null,
      registrationNumber: String(body.registrationNumber),
      yearEstablished: Number(body.yearEstablished),
      companyDescription: String(body.companyDescription),
      contactName: String(body.contactName),
      jobTitle: String(body.jobTitle),
      contactEmail: String(body.contactEmail),
      contactPhone: String(body.contactPhone),
      city: String(body.city),
      region: String(body.region),
      physicalAddress: String(body.physicalAddress),
      monthlyVolume: String(body.monthlyVolume),
      website: body.website ? String(body.website) : null,
      eventTypes: body.eventTypes ? String(body.eventTypes) : null,
      fleetInfo: body.fleetInfo ? String(body.fleetInfo) : null,
      paymentMethods: String(body.paymentMethods),
      settlementPreference: String(body.settlementPreference),
      bankName: body.bankName ? String(body.bankName) : null,
      accountName: body.accountName ? String(body.accountName) : null,
      accountNumber: body.accountNumber ? String(body.accountNumber) : null,
      branch: body.branch ? String(body.branch) : null,
      additionalNotes: body.additionalNotes ? String(body.additionalNotes) : null,
      termsVersion: LEGAL_VERSION,
    } satisfies QueryParams,
  );
  await emailService.sendPartnerApplicationReceived(
    String(body.contactEmail),
    String(body.companyName),
  );
  return { id, status: "submitted" };
}

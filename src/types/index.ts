export type UserRole = "customer" | "organizer" | "admin";
export type ListingKind = "event" | "travel";
export type EventFormat = "physical" | "virtual";
export type VirtualEventType = "one_time" | "ongoing";
export type VirtualBuyMode = "bundle_only" | "allow_session_selection";
export type VirtualPricingMode = "uniform" | "per_session";
export type ListingStatus = "published" | "draft" | "postponed" | "cancelled" | "sold_out";
export type SeatStatus = "available" | "taken" | "unavailable";
export type UserTicketStatus = "active" | "used" | "expired";
export type PaymentMethodType = "airtel" | "tnm" | "card";
export type PartnerType = "events" | "travel" | "both";

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
}

export interface ListingRow {
  id: string;
  organizer_id: string;
  kind: ListingKind;
  event_format?: EventFormat;
  virtual_event_type?: VirtualEventType;
  virtual_buy_mode?: VirtualBuyMode;
  virtual_pricing_mode?: VirtualPricingMode;
  title: string;
  subtitle: string;
  category: string;
  date_label: string;
  event_starts_on?: string | Date | null;
  ticket_capacity?: number | null;
  time_label: string;
  location: string;
  virtual_meeting_url?: string | null;
  virtual_duration_minutes?: number | null;
  price_mwk: number;
  image_url: string;
  description: string;
  operator_name: string;
  operator_tagline: string;
  operator_detail: string;
  route_from: string | null;
  route_to: string | null;
  route_duration: string | null;
  status: ListingStatus;
}

export interface VirtualEventSessionRow {
  id: string;
  listing_id: string;
  session_index: number;
  title: string;
  starts_at: string | Date;
  ends_at: string | Date;
  meeting_url: string | null;
  price_mwk: number;
  status: "scheduled" | "rescheduled" | "cancelled";
}

export interface SeatRow {
  id: string;
  seat_number: number;
  grid_row: number;
  grid_col: number;
  status: SeatStatus;
  customer_name: string | null;
}

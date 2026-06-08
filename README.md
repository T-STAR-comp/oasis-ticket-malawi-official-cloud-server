# Ticket Malawi Cloud Server

Node.js + Express API backed by **MySQL**, designed for the `ticket-malawi-app` frontend.

## Setup

1. Copy environment file:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
npm install
```

3. Create schema and seed demo data (requires MySQL running):

```bash
npm run db:schema
npm run db:seed
```

4. Start the API:

```bash
npm run dev
```

API base URL: `http://localhost:4000`

## Demo accounts (after seed)

| Role      | Email                 | Password     |
|-----------|-----------------------|--------------|
| Organizer | ops@sososo.mw         | Password123! |
| Customer  | chimwemwe@example.mw  | Password123! |

## API routes (mapped to frontend)

### Public

| Method | Route | Frontend |
|--------|-------|----------|
| GET | `/api/health` | Health check |
| GET | `/api/listings` | Home featured listings |
| GET | `/api/listings/:id` | `/ticket/$id` |
| GET | `/api/events` | `/events` |
| GET | `/api/travel` | `/travel` |
| POST | `/api/auth/signup` | `/sign-up` |
| POST | `/api/auth/signin` | `/sign-in` |
| POST | `/api/auth/magic-link` | Magic link (501 — disabled) |
| POST | `/api/partner-applications` | `/become-organizer` |

### Customer (Bearer token)

| Method | Route | Frontend |
|--------|-------|----------|
| GET | `/api/auth/me` | Account tab |
| PATCH | `/api/auth/me` | Edit profile |
| GET | `/api/dashboard/tickets` | Dashboard — My Tickets |
| GET | `/api/dashboard/history` | Dashboard — History + total spent |
| GET | `/api/dashboard/tickets/:id` | Ticket detail modal |
| POST | `/api/dashboard/tickets/:id/share` | Share ticket modal |
| GET | `/api/dashboard/payment-methods` | Payment methods |
| POST | `/api/checkout/:listingId` | `/checkout/$id` |

### Organizer (Bearer token, role `organizer`)

| Method | Route | Frontend |
|--------|-------|----------|
| GET | `/api/organizer/overview` | Revenue overview |
| GET | `/api/organizer/listings` | Manage tickets/events |
| POST | `/api/organizer/listings` | Create listing |
| PATCH | `/api/organizer/listings/:id` | Edit listing |
| PATCH | `/api/organizer/listings/:id/status` | Change status / postpone |
| PUT | `/api/organizer/listings/:id/seats` | Seat layout editor |
| DELETE | `/api/organizer/listings/:id` | Delete listing |
| GET | `/api/organizer/buyers` | Buyers table |
| GET | `/api/organizer/profile` | Organizer profile |
| PATCH | `/api/organizer/profile` | Edit profile |

## Database schema

See [`database/schema.sql`](database/schema.sql):

- `users`, `magic_link_tokens`
- `organizer_profiles`, `partner_applications`
- `listings` (events + travel)
- `seat_layouts`, `seats`
- `orders`, `order_items`, `user_tickets`
- `ticket_shares`, `payment_methods`

## Checkout example (multi-seat travel)

```http
POST /api/checkout/blantyre-lilongwe
Authorization: Bearer <token>
Content-Type: application/json

{
  "qty": 2,
  "seatNumbers": [4, 8],
  "paymentMethod": "airtel",
  "paymentPhone": "+265999123456",
  "contactName": "Chimwemwe Banda",
  "contactEmail": "chimwemwe@example.mw",
  "contactPhone": "+265999123456"
}
```

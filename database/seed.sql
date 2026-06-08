USE ticket_malawi;

SET @organizer_id = '11111111-1111-1111-1111-111111111111';

INSERT INTO organizer_profiles (id, user_id, company_name, contact_name, email, phone, partner_type, city, bio, status) VALUES
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', @organizer_id, 'Sososo Coaches Ltd.', 'James Phiri', 'ops@sososo.mw', '+265999456789', 'both', 'Blantyre', 'Executive intercity coach operator serving southern and central Malawi since 2012.', 'approved')
ON DUPLICATE KEY UPDATE company_name = company_name;

INSERT INTO listings (
  id, organizer_id, kind, title, subtitle, category, date_label, time_label, location,
  price_mwk, image_url, description, operator_name, operator_tagline, operator_detail,
  route_from, route_to, route_duration, status
) VALUES
('lake-of-stars', @organizer_id, 'event', 'Lake of Stars: Discovery', 'Three nights of music on the shore', 'Festival',
 'Oct 24–26', 'Gates 16:00', 'Senga Bay, Salima', 45000, '/assets/event-lakeofstars.jpg',
 'An intimate festival on the shores of Lake Malawi blending pan-African headliners with quiet acoustic moments at sunrise.',
 'Lake of Stars Foundation', 'Curating Malawi''s signature lakeside festival since 2004.', 'Three stages • Camping included • Headliners from 9 countries',
 NULL, NULL, NULL, 'published'),
('blantyre-lilongwe', @organizer_id, 'travel', 'Blantyre → Lilongwe', 'Executive coach, daily', 'Executive Bus',
 'Daily', '07:00', 'Wenela Terminal arrival', 22000, '/assets/travel-bus.jpg',
 'Comfortable 4h 30m intercity service with assigned seating, professional crew, and complimentary refreshments.',
 'Sososo Coaches Ltd.', 'Malawi''s premier executive travel.', 'Scania Marcopolo G8 • Climate control • On-board refreshments',
 'Blantyre', 'Lilongwe', '4h 30m', 'published'),
('creatives-summit', @organizer_id, 'event', 'Digital Creatives Summit', 'A day for makers and operators', 'Workshop',
 'Sept 12', '09:00 – 18:00', 'Amaryllis Hotel, Blantyre', 15000, '/assets/event-artsummit.jpg',
 'A focused day of talks and hands-on sessions covering product, design, and the business of digital craft in Malawi.',
 'Mzati Studio', 'Convening Malawi''s design and tech community.', '12 speakers • Workshops • Networking dinner',
 NULL, NULL, NULL, 'published')
ON DUPLICATE KEY UPDATE title = VALUES(title);

SET @layout_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO seat_layouts (id, listing_id, total_seats, grid_cols, grid_rows) VALUES
(@layout_id, 'blantyre-lilongwe', 24, 6, 6)
ON DUPLICATE KEY UPDATE total_seats = VALUES(total_seats);

INSERT INTO seats (id, layout_id, seat_number, grid_row, grid_col, status, customer_name) VALUES
('s001', @layout_id, 1,  0, 0, 'taken', 'Grace M.'),
('s002', @layout_id, 2,  0, 1, 'unavailable', NULL),
('s003', @layout_id, 3,  0, 2, 'taken', 'Peter K.'),
('s004', @layout_id, 4,  0, 3, 'available', NULL),
('s005', @layout_id, 5,  0, 4, 'unavailable', NULL),
('s006', @layout_id, 6,  0, 5, 'available', NULL),
('s007', @layout_id, 7,  1, 0, 'taken', 'Amina S.'),
('s008', @layout_id, 8,  1, 1, 'available', NULL),
('s009', @layout_id, 9,  1, 2, 'available', NULL),
('s010', @layout_id, 10, 1, 3, 'available', NULL),
('s011', @layout_id, 11, 1, 4, 'available', NULL),
('s012', @layout_id, 12, 1, 5, 'taken', 'Chimwemwe B.'),
('s013', @layout_id, 13, 2, 0, 'available', NULL),
('s014', @layout_id, 14, 2, 1, 'available', NULL),
('s015', @layout_id, 15, 2, 2, 'available', NULL),
('s016', @layout_id, 16, 2, 3, 'available', NULL),
('s017', @layout_id, 17, 2, 4, 'available', NULL),
('s018', @layout_id, 18, 2, 5, 'unavailable', NULL),
('s019', @layout_id, 19, 3, 0, 'available', NULL),
('s020', @layout_id, 20, 3, 1, 'available', NULL),
('s021', @layout_id, 21, 3, 2, 'available', NULL),
('s022', @layout_id, 22, 3, 3, 'available', NULL),
('s023', @layout_id, 23, 3, 4, 'available', NULL),
('s024', @layout_id, 24, 3, 5, 'available', NULL)
ON DUPLICATE KEY UPDATE status = VALUES(status);

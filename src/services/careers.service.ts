import type { RowDataPacket } from "mysql2";
import { v4 as uuid } from "uuid";
import { pool, type QueryParams } from "../db/pool.js";

export type ApplicationFieldType = "text" | "email" | "tel" | "url" | "textarea";

export type ApplicationField = {
  id: string;
  label: string;
  type: ApplicationFieldType;
  required: boolean;
  placeholder?: string;
};

export type JobPostStatus = "draft" | "published" | "closed";

export const DEFAULT_APPLICATION_FIELDS: ApplicationField[] = [
  { id: "fullName", label: "Full name", type: "text", required: true },
  { id: "email", label: "Email", type: "email", required: true },
  { id: "phone", label: "Phone", type: "tel", required: false, placeholder: "e.g. 0999123456" },
  {
    id: "coverLetter",
    label: "Cover letter / message",
    type: "textarea",
    required: false,
    placeholder: "Tell us why you are a good fit…",
  },
];

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function parseFields(raw: unknown): ApplicationField[] {
  if (!Array.isArray(raw)) return DEFAULT_APPLICATION_FIELDS;
  return raw
    .filter((f): f is ApplicationField => {
      return (
        typeof f === "object" &&
        f != null &&
        typeof (f as ApplicationField).id === "string" &&
        typeof (f as ApplicationField).label === "string"
      );
    })
    .map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type ?? "text",
      required: Boolean(f.required),
      placeholder: f.placeholder,
    }));
}

export function isJobDeadlinePassed(closesAt?: string | null): boolean {
  if (!closesAt) return false;
  return new Date(closesAt).getTime() <= Date.now();
}

function mapJob(row: RowDataPacket) {
  const closesAt = row.closes_at ? String(row.closes_at) : undefined;
  return {
    id: row.id as string,
    slug: row.slug as string,
    title: row.title as string,
    department: (row.department as string | null) ?? undefined,
    location: (row.location as string | null) ?? undefined,
    employmentType: (row.employment_type as string | null) ?? undefined,
    description: row.description as string,
    requirements: (row.requirements as string | null) ?? undefined,
    benefits: (row.benefits as string | null) ?? undefined,
    applyEmail: row.apply_email as string,
    applicationFields: parseFields(
      typeof row.application_fields === "string"
        ? JSON.parse(row.application_fields)
        : row.application_fields,
    ),
    status: row.status as JobPostStatus,
    publishedAt: row.published_at ? String(row.published_at) : undefined,
    closesAt,
    deadlinePassed: isJobDeadlinePassed(closesAt),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function uniqueSlug(title: string, excludeId?: string): Promise<string> {
  const base = slugify(title) || "role";
  let candidate = base;
  let n = 0;
  while (true) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM job_posts WHERE slug = :slug ${excludeId ? "AND id != :excludeId" : ""} LIMIT 1`,
      { slug: candidate, excludeId } satisfies QueryParams,
    );
    if (!rows[0]) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}

export async function listPublishedJobs() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM job_posts
     WHERE status = 'published'
     ORDER BY
       CASE WHEN closes_at IS NOT NULL AND closes_at <= NOW() THEN 1 ELSE 0 END,
       published_at DESC,
       created_at DESC`,
  );
  return rows.map(mapJob);
}

export async function getPublishedJob(slugOrId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM job_posts
     WHERE status = 'published'
       AND (slug = :key OR id = :key)
     LIMIT 1`,
    { key: slugOrId },
  );
  const row = rows[0];
  return row ? mapJob(row) : null;
}

export async function listAllJobs() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM job_posts ORDER BY created_at DESC`,
  );
  return rows.map(mapJob);
}

export async function getJob(id: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM job_posts WHERE id = :id LIMIT 1`,
    { id },
  );
  const row = rows[0];
  return row ? mapJob(row) : null;
}

export type JobPostInput = {
  title: string;
  description: string;
  applyEmail: string;
  department?: string;
  location?: string;
  employmentType?: "full_time" | "part_time" | "contract" | "internship" | "other";
  requirements?: string;
  benefits?: string;
  applicationFields?: ApplicationField[];
  status?: JobPostStatus;
  closesAt?: string | null;
};

export async function createJob(adminId: string, input: JobPostInput) {
  const id = uuid();
  const slug = await uniqueSlug(input.title);
  const status = input.status ?? "draft";
  const fields = input.applicationFields?.length
    ? input.applicationFields
    : DEFAULT_APPLICATION_FIELDS;

  await pool.query(
    `INSERT INTO job_posts (
      id, slug, title, department, location, employment_type, description,
      requirements, benefits, apply_email, application_fields, status,
      published_at, closes_at, created_by
    ) VALUES (
      :id, :slug, :title, :department, :location, :employmentType, :description,
      :requirements, :benefits, :applyEmail, :applicationFields, :status,
      :publishedAt, :closesAt, :createdBy
    )`,
    {
      id,
      slug,
      title: input.title.trim(),
      department: input.department?.trim() || null,
      location: input.location?.trim() || null,
      employmentType: input.employmentType ?? null,
      description: input.description.trim(),
      requirements: input.requirements?.trim() || null,
      benefits: input.benefits?.trim() || null,
      applyEmail: input.applyEmail.trim().toLowerCase(),
      applicationFields: JSON.stringify(fields),
      status,
      publishedAt: status === "published" ? new Date().toISOString() : null,
      closesAt: input.closesAt ? new Date(input.closesAt).toISOString() : null,
      createdBy: adminId,
    } satisfies QueryParams,
  );

  return getJob(id);
}

export async function updateJob(id: string, input: Partial<JobPostInput>) {
  const existing = await getJob(id);
  if (!existing) throw new Error("Job post not found");

  const title = input.title?.trim() ?? existing.title;
  const slug =
    input.title && input.title.trim() !== existing.title
      ? await uniqueSlug(title, id)
      : existing.slug;
  const status = input.status ?? existing.status;
  const wasPublished = existing.status === "published";
  const publishedAt =
    status === "published" && !wasPublished
      ? new Date().toISOString()
      : existing.publishedAt ?? null;

  const fields =
    input.applicationFields && input.applicationFields.length > 0
      ? input.applicationFields
      : existing.applicationFields;

  await pool.query(
    `UPDATE job_posts SET
      slug = :slug,
      title = :title,
      department = :department,
      location = :location,
      employment_type = :employmentType,
      description = :description,
      requirements = :requirements,
      benefits = :benefits,
      apply_email = :applyEmail,
      application_fields = :applicationFields,
      status = :status,
      published_at = :publishedAt,
      closes_at = :closesAt
     WHERE id = :id`,
    {
      id,
      slug,
      title,
      department: input.department !== undefined ? input.department?.trim() || null : existing.department ?? null,
      location: input.location !== undefined ? input.location?.trim() || null : existing.location ?? null,
      employmentType:
        input.employmentType !== undefined ? input.employmentType ?? null : existing.employmentType ?? null,
      description: input.description?.trim() ?? existing.description,
      requirements:
        input.requirements !== undefined ? input.requirements?.trim() || null : existing.requirements ?? null,
      benefits: input.benefits !== undefined ? input.benefits?.trim() || null : existing.benefits ?? null,
      applyEmail: input.applyEmail?.trim().toLowerCase() ?? existing.applyEmail,
      applicationFields: JSON.stringify(fields),
      status,
      publishedAt,
      closesAt:
        input.closesAt !== undefined
          ? input.closesAt
            ? new Date(input.closesAt).toISOString()
            : null
          : existing.closesAt ?? null,
    } satisfies QueryParams,
  );

  return getJob(id);
}

export async function deleteJob(id: string) {
  const [result] = await pool.query(
    `DELETE FROM job_posts WHERE id = :id`,
    { id },
  );
  if ((result as { affectedRows?: number }).affectedRows === 0) {
    throw new Error("Job post not found");
  }
  return { deleted: true };
}

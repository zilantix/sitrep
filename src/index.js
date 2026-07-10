/**
 * SITREP — project command center for meeting prep.
 * Cloudflare Worker: JSON API over D1 + Anthropic-powered brief generation.
 * Static frontend is served by the [assets] binding; only /api/* reaches this code.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };
const ok = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const err = (message, status = 400) => ok({ error: message }, status);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (e) {
      console.error(e);
      return err(e.message || "Internal error", 500);
    }
  },

  // Optional cron: pre-generate the consolidated meeting prep each morning.
  async scheduled(_event, env) {
    try {
      await generateMeetingPrep(env);
    } catch (e) {
      console.error("Scheduled prep failed:", e);
    }
  },
};

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  const m = (re) => pathname.match(re);
  let match;

  // ---- Projects ----
  if (pathname === "/api/projects" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM updates u WHERE u.project_id = p.id) AS update_count,
              (SELECT COUNT(*) FROM notes n WHERE n.project_id = p.id)   AS note_count,
              (SELECT MAX(created_at) FROM briefs b WHERE b.project_id = p.id) AS last_brief_at
       FROM projects p ORDER BY p.updated_at DESC`
    ).all();
    return ok(results);
  }

  if (pathname === "/api/projects" && method === "POST") {
    const body = await request.json();
    if (!body.name?.trim()) return err("Project name is required");
    const r = await env.DB.prepare(
      `INSERT INTO projects (name, description, stakeholders, status)
       VALUES (?, ?, ?, ?) RETURNING *`
    )
      .bind(
        body.name.trim(),
        body.description?.trim() || "",
        body.stakeholders?.trim() || "",
        VALID_STATUS.has(body.status) ? body.status : "planned"
      )
      .first();
    return ok(r, 201);
  }

  if ((match = m(/^\/api\/projects\/(\d+)$/))) {
    const id = Number(match[1]);
    if (method === "GET") {
      const project = await env.DB.prepare(`SELECT * FROM projects WHERE id = ?`)
        .bind(id).first();
      if (!project) return err("Project not found", 404);
      const [updates, notes, briefs] = await Promise.all([
        env.DB.prepare(`SELECT * FROM updates WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`).bind(id).all(),
        env.DB.prepare(`SELECT * FROM notes WHERE project_id = ? ORDER BY created_at DESC LIMIT 50`).bind(id).all(),
        env.DB.prepare(`SELECT * FROM briefs WHERE project_id = ? ORDER BY created_at DESC LIMIT 10`).bind(id).all(),
      ]);
      return ok({ ...project, updates: updates.results, notes: notes.results, briefs: briefs.results });
    }
    if (method === "PATCH") {
      const body = await request.json();
      const fields = [];
      const vals = [];
      for (const k of ["name", "description", "stakeholders"]) {
        if (typeof body[k] === "string") { fields.push(`${k} = ?`); vals.push(body[k].trim()); }
      }
      if (body.status) {
        if (!VALID_STATUS.has(body.status)) return err("Invalid status");
        fields.push("status = ?"); vals.push(body.status);
      }
      if (!fields.length) return err("Nothing to update");
      fields.push("updated_at = datetime('now')");
      const r = await env.DB.prepare(
        `UPDATE projects SET ${fields.join(", ")} WHERE id = ? RETURNING *`
      ).bind(...vals, id).first();
      return r ? ok(r) : err("Project not found", 404);
    }
    if (method === "DELETE") {
      await env.DB.prepare(`DELETE FROM projects WHERE id = ?`).bind(id).run();
      return ok({ deleted: id });
    }
  }

  // ---- Updates & notes ----
  if ((match = m(/^\/api\/projects\/(\d+)\/updates$/)) && method === "POST") {
    const body = await request.json();
    if (!body.content?.trim()) return err("Update content is required");
    const r = await env.DB.prepare(
      `INSERT INTO updates (project_id, content) VALUES (?, ?) RETURNING *`
    ).bind(Number(match[1]), body.content.trim()).first();
    await touch(env, match[1]);
    return ok(r, 201);
  }

  if ((match = m(/^\/api\/projects\/(\d+)\/notes$/)) && method === "POST") {
    const body = await request.json();
    if (!body.content?.trim()) return err("Note content is required");
    const r = await env.DB.prepare(
      `INSERT INTO notes (project_id, content, meeting_date) VALUES (?, ?, ?) RETURNING *`
    ).bind(
      Number(match[1]),
      body.content.trim(),
      body.meeting_date || new Date().toISOString().slice(0, 10)
    ).first();
    await touch(env, match[1]);
    return ok(r, 201);
  }

  if ((match = m(/^\/api\/updates\/(\d+)$/)) && method === "DELETE") {
    await env.DB.prepare(`DELETE FROM updates WHERE id = ?`).bind(Number(match[1])).run();
    return ok({ deleted: Number(match[1]) });
  }
  if ((match = m(/^\/api\/notes\/(\d+)$/)) && method === "DELETE") {
    await env.DB.prepare(`DELETE FROM notes WHERE id = ?`).bind(Number(match[1])).run();
    return ok({ deleted: Number(match[1]) });
  }

  // ---- Generation ----
  if ((match = m(/^\/api\/projects\/(\d+)\/brief$/)) && method === "POST") {
    return ok(await generateProjectBrief(env, Number(match[1])), 201);
  }
  if (pathname === "/api/meeting-prep" && method === "POST") {
    return ok(await generateMeetingPrep(env), 201);
  }
  if (pathname === "/api/meeting-prep" && method === "GET") {
    const r = await env.DB.prepare(
      `SELECT * FROM briefs WHERE kind = 'meeting_prep' ORDER BY created_at DESC LIMIT 1`
    ).first();
    return r ? ok(r) : err("No meeting prep generated yet", 404);
  }

  return err("Not found", 404);
}

const VALID_STATUS = new Set(["planned", "active", "blocked", "complete"]);

async function touch(env, id) {
  await env.DB.prepare(
    `UPDATE projects SET updated_at = datetime('now') WHERE id = ?`
  ).bind(Number(id)).run();
}

// ---------------------------------------------------------------- generation

async function generateProjectBrief(env, projectId) {
  const project = await env.DB.prepare(`SELECT * FROM projects WHERE id = ?`)
    .bind(projectId).first();
  if (!project) throw new Error("Project not found");

  const lastBrief = await env.DB.prepare(
    `SELECT * FROM briefs WHERE project_id = ? AND kind = 'sitrep'
     ORDER BY created_at DESC LIMIT 1`
  ).bind(projectId).first();
  const since = lastBrief?.created_at || "1970-01-01";

  const [updates, notes] = await Promise.all([
    env.DB.prepare(
      `SELECT content, created_at FROM updates
       WHERE project_id = ? ORDER BY created_at DESC LIMIT 40`
    ).bind(projectId).all(),
    env.DB.prepare(
      `SELECT content, meeting_date, created_at FROM notes
       WHERE project_id = ? ORDER BY created_at DESC LIMIT 15`
    ).bind(projectId).all(),
  ]);

  const system = `You are an operations analyst preparing a SITREP (situation report) for a senior cloud architect who oversees multiple AWS projects. Be concrete, terse, and decision-oriented. Never invent facts not present in the source material; if information is missing, surface it as a question instead.
Respond with ONLY a valid JSON object (no markdown fences, no commentary) with exactly these keys:
{
  "summary": "3-5 sentence plain-language state of the project",
  "delta": "what changed since the previous brief; 'First brief for this project.' if none",
  "obstacles": ["current blockers and risks, most severe first"],
  "plan": ["recommended next actions in priority order, each starting with a verb"],
  "questions": ["sharp questions to ask the team at the next meeting"],
  "decisions_needed": ["decisions awaiting the architect or leadership; empty array if none"]
}`;

  const userMsg = [
    `PROJECT: ${project.name} (status: ${project.status})`,
    project.description && `DESCRIPTION: ${project.description}`,
    project.stakeholders && `STAKEHOLDERS: ${project.stakeholders}`,
    lastBrief
      ? `PREVIOUS BRIEF (${lastBrief.created_at} UTC):\n${lastBrief.content_json}`
      : `PREVIOUS BRIEF: none — this is the first brief.`,
    `UPDATES (newest first, ★ = added since previous brief):`,
    fmtItems(updates.results, since, (u) => u.content, (u) => u.created_at),
    `MEETING NOTES (newest first, ★ = added since previous brief):`,
    fmtItems(notes.results, since, (n) => `[meeting ${n.meeting_date}] ${n.content}`, (n) => n.created_at),
  ].filter(Boolean).join("\n\n");

  const content = await callLLM(env, system, userMsg, 3000);
  const brief = await env.DB.prepare(
    `INSERT INTO briefs (project_id, kind, content_json, model)
     VALUES (?, 'sitrep', ?, ?) RETURNING *`
  ).bind(projectId, JSON.stringify(content), modelName(env)).first();
  await touch(env, projectId);
  return brief;
}

async function generateMeetingPrep(env) {
  const { results: projects } = await env.DB.prepare(
    `SELECT * FROM projects WHERE status != 'complete' ORDER BY
       CASE status WHEN 'blocked' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, updated_at DESC`
  ).all();
  if (!projects.length) throw new Error("No active projects to prepare for");

  const sections = [];
  for (const p of projects) {
    const [latest, updates] = await Promise.all([
      env.DB.prepare(
        `SELECT content_json, created_at FROM briefs
         WHERE project_id = ? AND kind = 'sitrep' ORDER BY created_at DESC LIMIT 1`
      ).bind(p.id).first(),
      env.DB.prepare(
        `SELECT content, created_at FROM updates
         WHERE project_id = ? ORDER BY created_at DESC LIMIT 10`
      ).bind(p.id).all(),
    ]);
    sections.push(
      [
        `### ${p.name} (status: ${p.status})`,
        p.description && `Description: ${p.description}`,
        latest ? `Latest SITREP (${latest.created_at} UTC): ${latest.content_json}` : `Latest SITREP: none`,
        `Recent updates:`,
        updates.results.map((u) => `- (${u.created_at}) ${u.content}`).join("\n") || "- none",
      ].filter(Boolean).join("\n")
    );
  }

  const system = `You are preparing a senior cloud architect for a program status meeting covering multiple AWS projects. Synthesize across projects; be terse and decision-oriented. Never invent facts.
Respond with ONLY a valid JSON object (no markdown fences) with exactly these keys:
{
  "overview": "2-4 sentence read on the overall program state",
  "projects": [{"name": "...", "status_line": "one-line where-we-are", "top_obstacle": "single most important blocker or 'none'", "questions": ["questions to ask about this project"]}],
  "cross_cutting": ["themes, risks, or dependencies spanning multiple projects"],
  "suggested_agenda": ["ordered talking points for the meeting, highest-stakes first"]
}`;

  const content = await callLLM(env, system, sections.join("\n\n---\n\n"), 4000);
  return env.DB.prepare(
    `INSERT INTO briefs (project_id, kind, content_json, model)
     VALUES (NULL, 'meeting_prep', ?, ?) RETURNING *`
  ).bind(JSON.stringify(content), modelName(env)).first();
}

function fmtItems(rows, since, text, ts) {
  if (!rows.length) return "- none recorded";
  return rows
    .map((r) => `- ${ts(r) > since ? "★ " : ""}(${ts(r)} UTC) ${text(r)}`)
    .join("\n");
}

async function callLLM(env, system, user, maxTokens) {
  const raw = env.PROVIDER === "anthropic"
    ? await callAnthropic(env, system, user, maxTokens)
    : await callWorkersAI(env, system, user, maxTokens);
  const clean = raw.replace(/```json|```/g, "").trim();
  // Some models wrap JSON in prose; grab the outermost object if direct parse fails.
  try {
    return JSON.parse(clean);
  } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    throw new Error("Model returned non-JSON output; try regenerating");
  }
}

async function callWorkersAI(env, system, user, maxTokens) {
  if (!env.AI) throw new Error("Workers AI binding missing — check the [ai] block in wrangler.toml");
  const result = await env.AI.run(env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
  });
  const text = typeof result === "string" ? result : result.response;
  if (!text) throw new Error("Workers AI returned an empty response; try regenerating");
  return text;
}

async function callAnthropic(env, system, user, maxTokens) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Run: npx wrangler secret put ANTHROPIC_API_KEY");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.MODEL || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function modelName(env) {
  return env.PROVIDER === "anthropic"
    ? (env.MODEL || "claude-sonnet-4-6")
    : (env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
}

# Skill Format

All skills in this repository should follow one common per-skill format:

- `<skill-root>/skill.json`
- `<skill-root>/SKILL.md`
- `<skill-root>/README.md` (optional)
- `<skill-root>/references/*` (optional)

Rules:

- `skill.json` is the compact machine-readable manifest for the skill.
- `SKILL.md` is the human-facing and agent-facing execution body.
- Keep frontmatter in `SKILL.md` for client compatibility, but treat `skill.json` as the canonical structured metadata file.
- Optional skill packs reuse the same per-skill format and additionally wrap skills inside `template/skill-packs/<pack-id>/` with a `pack.json`.
- Core skills and live-only custom skills do not need `pack.json`; the per-skill contract stays the same.
- The skill ids `orchestration` and `orchestration-depth1` are reserved: earlier releases shipped them as baseline skills. An update removes an unmodified shipped copy; a modified copy is kept, ignored and still content-scanned, and can be removed by deleting the whole directory. Do not use them for a pack or custom skill.

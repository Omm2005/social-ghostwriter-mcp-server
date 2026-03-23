# Posting Guide (`linkedin_create_post`)

This guide explains how to call `linkedin_create_post` with the current input model: mentions by `target_text` and media by direct URL.

## 1) Tool Input Shape

```json
{
  "text": "string (required)",
  "author_urn": "urn:li:person:<id> | urn:li:organization:<id> (optional)",
  "lifecycle_state": "PUBLISHED | DRAFT (optional, default PUBLISHED)",
  "visibility": "PUBLIC | CONNECTIONS (optional, default PUBLIC)",
  "mentions": [
    {
      "entity_urn": "urn:li:person:<id> | urn:li:organization:<id>",
      "entity_link": "https://www.linkedin.com/in/<handle>/ | https://www.linkedin.com/company/<vanity>/",
      "entity_name": "optional display name",
      "target_text": "word or phrase in text (required)",
      "occurrence": "optional integer >= 1, default 1",
      "entity_type": "member | company"
    }
  ],
  "media": [
    {
      "type": "IMAGE | VIDEO",
      "url": "https://... (required direct media URL)",
      "title": "optional",
      "description": "optional"
    }
  ]
}
```

## 2) Mention Rules (`target_text` Required)

- `target_text`: exact word/phrase in `text` to mention
- `occurrence`: which match to use when repeated (`1` = first, `2` = second, etc.)
- `entity_link`: LinkedIn URL for the mentioned entity (required for user reference)
- `entity_name`: optional display name; checker may overwrite it when different
- `entity_type`:
  - `company` -> `entity_urn` must be `urn:li:organization:...`
  - `member` -> `entity_urn` must be `urn:li:person:...`

Browser Use checker behavior:
- `entity_link` is sent to your configured Browser Use skill before posting.
- If checker returns different URN or name, values are auto-corrected.
- Tool response includes `mention_corrections`.

### Quick Example (`target_text`)

```json
{
  "entity_urn": "urn:li:organization:1035",
  "entity_link": "https://www.linkedin.com/company/microsoft/",
  "target_text": "Microsoft",
  "occurrence": 1,
  "entity_type": "company"
}
```

## 3) Valid Payload Examples

### A) Text + Mention (No Media)

```json
{
  "text": "Test mention Microsoft only.",
  "visibility": "PUBLIC",
  "mentions": [
    {
      "entity_urn": "urn:li:organization:1035",
      "entity_link": "https://www.linkedin.com/company/microsoft/",
      "target_text": "Microsoft",
      "entity_type": "company"
    }
  ]
}
```

### B) Image Post + Mention (Public URL)

```json
{
  "text": "Image test for Microsoft.",
  "visibility": "PUBLIC",
  "mentions": [
    {
      "entity_urn": "urn:li:organization:1035",
      "entity_link": "https://www.linkedin.com/company/microsoft/",
      "target_text": "Microsoft",
      "entity_type": "company"
    }
  ],
  "media": [
    {
      "type": "IMAGE",
      "url": "https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg",
      "title": "Example Image",
      "description": "Upload test"
    }
  ]
}
```

### C) Video Post

```json
{
  "text": "Video upload test run.",
  "visibility": "PUBLIC",
  "media": [
    {
      "type": "VIDEO",
      "url": "https://samplelib.com/lib/preview/mp4/sample-5s.mp4",
      "title": "Sample Video",
      "description": "Video upload test"
    }
  ]
}
```

### D) Mixed IMAGE + VIDEO in One Call

When both types are present, the tool creates separate LinkedIn posts per media type and returns all IDs.

```json
{
  "text": "Mixed media test.",
  "visibility": "PUBLIC",
  "media": [
    {
      "type": "IMAGE",
      "url": "https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg",
      "title": "Image Part",
      "description": "Mixed test image"
    },
    {
      "type": "VIDEO",
      "url": "https://samplelib.com/lib/preview/mp4/sample-5s.mp4",
      "title": "Video Part",
      "description": "Mixed test video"
    }
  ]
}
```

## 4) Frequent Errors and Fixes

### `Duplicate post is detected` (422)
LinkedIn blocked duplicate content.
- Change text slightly (append timestamp/hash)
- Change media title/description

### `LinkedIn rejected media type ... 415`
Your media content type does not match what LinkedIn accepts.
- For image uploads, content type must be JPG/PNG/GIF.
- For URL uploads, verify with: `curl -I <url>` and confirm `Content-Type`.

### `mentions[i] must include target_text`
The mention object is missing `target_text`.
- Add `target_text` for every mention item.

### `target_text not found in post text`
The phrase was not found in `text` at runtime.
- Ensure exact case-sensitive match.
- If repeated, set `occurrence` to the intended match number.

### Mention not linking correctly
- Recheck `target_text` exactly matches your post text (case-sensitive)
- If target appears multiple times, set `occurrence` (1, 2, 3, ...)
- Verify URN/entity type pairing (`company` + org URN, `member` + person URN)

## 5) Safe Testing Pattern

1. Start with text-only payload.
2. Add one mention with `target_text`.
3. Add one image.
4. Add one video.
5. Then try mixed media.

This sequence makes it easier to isolate whether a failure is mention targeting, media URL, or LinkedIn-side behavior.

# Posting Guide (`linkedin_create_post`)

This guide explains how to call the unified `linkedin_create_post` tool, including mention index math (`start` + `length`) and media fields.

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
      "start": 0,
      "length": 1,
      "entity_type": "member | company"
    }
  ],
  "media": [
    {
      "type": "IMAGE | VIDEO",
      "url": "https://...",
      "title": "optional",
      "description": "optional"
    }
  ]
}
```

## 2) Mention Index Rules (`start`, `length`)

Mentions depend on exact character positions in `text`.

- `start`: 0-based character index where the mentioned word starts
- `length`: number of characters in the mentioned word
- `entity_type`:
  - `company` -> `entity_urn` must be `urn:li:organization:...`
  - `member` -> `entity_urn` must be `urn:li:person:...`

### Quick Example

Text:

```text
Test mention Microsoft only.
```

Index map:
- `Test` -> chars `0-3`
- space -> `4`
- `mention` -> `5-11`
- space -> `12`
- `Microsoft` -> `13-21`

So mention object is:

```json
{
  "entity_urn": "urn:li:organization:1035",
  "start": 13,
  "length": 9,
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
      "start": 13,
      "length": 9,
      "entity_type": "company"
    }
  ]
}
```

### B) Image Post + Mention

```json
{
  "text": "Image test for Microsoft.",
  "visibility": "PUBLIC",
  "mentions": [
    {
      "entity_urn": "urn:li:organization:1035",
      "start": 15,
      "length": 9,
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
Your media URL is not a direct supported media file.
- For images, use direct JPG/PNG/GIF URL
- Check with: `curl -I <url>` and confirm `Content-Type`

### Mention not linking correctly
- Recheck `start` and `length` against exact text
- Verify URN/entity type pairing (`company` + org URN, `member` + person URN)

## 5) Safe Testing Pattern

1. Start with text-only payload.
2. Add one mention.
3. Add one image.
4. Add one video.
5. Then try mixed media.

This sequence makes it easier to isolate whether a failure is mention indexing, media URL, or LinkedIn-side behavior.

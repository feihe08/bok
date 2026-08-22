# Codex bookmark bridge

Bok can expose a local, opt-in bridge for Codex to read the Chrome bookmark tree,
preview folder renames and bookmark moves, and apply an exact reviewed plan.

The bridge uses Chrome Native Messaging. It does not expose an HTTP port. The
native host accepts local connections only through a user-owned Unix socket, and
Chrome accepts the host only from Bok's fixed extension ID.

## Setup

1. Run `pnpm bookmarks:install-bridge`.
2. Build and reload Bok in Chrome.
3. Open Bok settings, then enable **Allow Codex bookmark access**.
4. Verify the connection with `pnpm bookmarks:codex ping`.

## Read bookmarks

```sh
pnpm bookmarks:codex tree
```

## Preview and apply a plan

Create a JSON file containing an `operations` array. A rename is limited to a
normal folder. A move is limited to a bookmark; it cannot move a folder.

```json
{
  "operations": [
    {
      "type": "rename-folder",
      "expected": {
        "id": "125",
        "kind": "folder",
        "title": "Read Source",
        "url": null,
        "parentId": "1",
        "index": 1
      },
      "title": "blog"
    },
    {
      "type": "move-bookmark",
      "expected": {
        "id": "152",
        "kind": "bookmark",
        "title": "从数据库到 AI - 学习让我快乐",
        "url": "https://example.com/article",
        "parentId": "125",
        "index": 0
      },
      "destination": {
        "expected": {
          "id": "25",
          "kind": "folder",
          "title": "Todo",
          "url": null,
          "parentId": "1",
          "index": 0
        },
        "index": null
      }
    }
  ]
}
```

Preview first:

```sh
pnpm bookmarks:codex plan /path/to/plan.json
```

Apply the same reviewed file:

```sh
pnpm bookmarks:codex apply /path/to/plan.json
```

Before applying, Bok verifies every node ID, title, source parent and target
folder. If an operation fails after earlier writes, Bok attempts to roll those
writes back in reverse order.

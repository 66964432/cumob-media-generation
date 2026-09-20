# TIDE01 32-Second Product Promo Case Study

## Goal

Turn a Word storyboard and embedded reference images into a 32-second vertical product promo with English dialogue and environmental audio.

## Constraints

- Three ten-second generated clips plus a two-second static end card.
- One character, one handheld phone and one timber jetty at night.
- Scene 1 is a selfie, Scene 2 is an almost-black sea view and Scene 3 is a product macro.
- The last frame of each generated clip becomes the next clip's first-frame reference.
- The product always has two buttons: granular on the left and five raised ribs on the right.
- Only one thumb may appear in Scene 3.
- Dialogue and environmental audio must be generated and verified.

## Workflow

1. Codex reads the Word document and reference images.
2. It identifies product-accuracy, hand-anatomy, lip-sync and chained-generation risks.
3. It asks the user to confirm the product, voice, end card and retry limit.
4. It generates the difficult product shot as a technical pilot first.
5. Frame inspection finds that the first pilot does not move the thumb clearly enough to the right button.
6. The prompt is rewritten with explicit travel distance, button-center targets and a single sustained hold.
7. After approval, the three clips are generated in dependency order: Scene 1 → F1 → Scene 2 → F2 → Scene 3.
8. Keyframes are inspected for identity, exposure, button geometry, fingers and red-light behavior.
9. Audio tracks are extracted and the English dialogue is transcribed.
10. Voice timing and a malformed final line are repaired in post.
11. All clips are normalized to 1080×1920 at 30 fps and a two-second end card is added.
12. The exact 32-second H.264 + AAC master is exported.

## Chained generation

```text
S01 character first frame → Scene 1 → F1
F1 → Scene 2 → F2
F2 + product references → Scene 3
S11 → two-second end card
```

Chaining cannot guarantee a mathematically seamless continuation because the model may reinterpret the reference image, but it reduces abrupt changes in subject, environment and motion direction.

![Three-stage chained workflow](../../assets/tide01-workflow-chain.png)

## What the case demonstrates

- Analyze and confirm before spending generation attempts.
- Test the highest-risk shot first.
- Inspect generated frames instead of trusting task success alone.
- Resume existing asynchronous tasks rather than submitting duplicates.
- Verify generated speech through transcription.
- Treat post-production as part of delivery, not an optional afterthought.

## Output

- Duration: 32 seconds
- Canvas: 1080×1920
- Frame rate: 30 fps
- Video: H.264
- Audio: AAC, 48 kHz stereo
- Music: none
- Captions: none
- End card: `NIGHTFIELD TIDE 01 / Keep the light on the task.`

## Publication hygiene

Public case material must not contain API keys, local usernames or absolute paths, task IDs, temporary download URLs, signed media URLs or customer material without permission.

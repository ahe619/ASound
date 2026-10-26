# Vocabulary illustrations

The first batch contains exactly three optional illustrations: **bridge** (桥),
**harvest** (收获), and **balance** (平衡). These senses were checked against the
existing entries in `app/vocabulary/words.json`. The illustrations do not change
the dictionary, exam membership, topic filters, or random word selection.

Each image was newly generated with one independent call to the built-in
`image_gen.imagegen` tool on 2026-10-26. No reference images were supplied. The
prompts requested general scenes without text, people, brands, recognizable
landmarks, or existing characters. The outputs were visually inspected for the
selected meaning. This provenance records how the files were made; it is not a
guarantee of exclusive rights or absence of similarity to other images.

`app/vocabulary/illustrations.json` records the full final prompts, bilingual
selected senses and alt text, source-image hashes, publication-image hashes,
dimensions, and encoding settings. Original PNGs are retained in the local
`build/generated-vocabulary-originals/` archive and at the original generator
output location. The release uses the full-frame 960 × 720 WebP versions in
`app/img/vocabulary/`; conversion changes encoding and resolution, without
cropping or redrawing the scene. The three release files total **346,008 bytes**.

The learning card calls `createWordIllustration(word)` only after revealing or
submitting an answer. Unmapped words show no empty frame. A missing manifest,
image, or stylesheet does not block text study. The helper creates an image only
for the currently revealed mapped word. The existing PWA release installer may
precache these small images with other app assets for offline use; this is not
an AI-model download and does not run image generation on the learner's device.

Run `node --test tests/test_word_illustrations.mjs` to validate the published
mapping and assets. Do not seed production learning progress or change random
selection to make these examples appear more often.

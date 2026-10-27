# Vocabulary illustrations

The published set contains **614** optional illustrations. The first batch has **bridge** (桥),
**harvest** (收获), and **balance** (平衡). These senses were checked against the
existing entries in `app/vocabulary/words.json`. The illustrations do not change
the dictionary, exam membership, or topic filters. New random **Say it** rounds
select pictured words when enough match the selected filters; other modes keep
their normal selection.

Each of the first three images was newly generated with one independent call to the built-in
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

The remaining **611** pictures were generated locally with Z-Image-Turbo from
one written scene per word and published as 480 × 360 WebP files. The manifest
records the model revision, seed, prompt, encoding and file hash. The publication
script checks the selected sense against the word entry and requires an OCR
screen for those exact bytes. OCR screening is not a complete visual or semantic
review of every picture.

The app reads the compact `pictures.json` index. Flashcards, choice and spelling
show pictures after revealing or submitting an answer; Say it uses a wordless
picture cue before the answer. Unmapped words show no empty frame, and missing
images do not block text study. Pictures are prefetched around the current card
and cached on use rather than downloaded during the initial PWA installation.
Image generation does not run on the learner's device.

Run `node --test tests/test_word_illustrations.mjs` to validate the published
mapping and assets. Do not seed production learning progress to make examples
appear more often, or broaden the selected exam deck when choosing pictured words.

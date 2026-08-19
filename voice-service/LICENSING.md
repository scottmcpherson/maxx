# Operator-supplied artifacts

The Voice Service package has no runtime dependencies, MLX runtime, model
checkpoints, tokenizers, reference recordings, or transcripts bundled with
it. The package metadata intentionally has an empty runtime dependency list.

Deployments may inject MLX Audio, other provider packages, model files, and
voice reference artifacts through the backend interface. Operators are
responsible for reviewing and complying with the applicable licenses and
terms for each provider, checkpoint, tokenizer, recording, and transcript.
They must also obtain and retain the required rights and explicit consent for
any voice data registered with the service. This note is operational guidance,
not legal advice.

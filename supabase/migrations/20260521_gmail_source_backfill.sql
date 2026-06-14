-- Correct historical Gmail bridge captures that predate the explicit
-- source: "gmail" payload field. This is intentionally limited to the
-- bridge's stable content prefix so unrelated ChatGPT captures are untouched.

update public.thoughts
set metadata = jsonb_set(metadata, '{source}', '"gmail"')
where metadata->>'source' = 'chatgpt'
  and content like 'Email thread:%';

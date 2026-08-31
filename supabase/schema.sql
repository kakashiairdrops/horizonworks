-- Run this in the Supabase SQL editor before setting environment variables.
create table if not exists applications (
  id text primary key,
  created_at timestamptz not null default now(),
  source text not null,
  values jsonb not null default '{}'::jsonb
);

create table if not exists briefs (
  id text primary key,
  created_at timestamptz not null default now(),
  source text not null,
  values jsonb not null default '{}'::jsonb
);

create table if not exists payments (
  id text primary key,
  created_at timestamptz not null default now(),
  status text not null default 'pending_confirmation',
  amount numeric,
  asset text,
  network text,
  values jsonb not null default '{}'::jsonb
);

create table if not exists projects (
  id text primary key,
  created_at timestamptz not null default now(),
  name text not null,
  status text not null default 'active',
  values jsonb not null default '{}'::jsonb
);

alter table applications enable row level security;
alter table briefs enable row level security;
alter table payments enable row level security;
alter table projects enable row level security;

-- The server uses the service-role key and never exposes it to browsers.

-- Límite de envíos desde la web (anti-abuso).
-- Cada envío dispara correos (Resend) y llamadas a la IA (Anthropic), así que
-- se frena a quien envíe demasiado: por correo y en total.
--   · Máximo 3 envíos por correo en 1 hora.
--   · Máximo 20 envíos en total en 10 minutos (por tabla).
-- La web reconoce el mensaje "limite_envios" y muestra un aviso amable.

create or replace function public.reclamaciones_limitar_envios()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  por_email int;
  total int;
begin
  execute format(
    'select count(*) from %I where lower(email) = lower($1) and created_at > now() - interval ''1 hour''',
    TG_TABLE_NAME) into por_email using new.email;
  if por_email >= 3 then
    raise exception 'limite_envios: demasiados envíos desde este correo' using errcode = 'P0001';
  end if;

  execute format(
    'select count(*) from %I where created_at > now() - interval ''10 minutes''',
    TG_TABLE_NAME) into total;
  if total >= 20 then
    raise exception 'limite_envios: demasiados envíos en poco tiempo' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.reclamaciones_limitar_envios() from public, anon, authenticated;

drop trigger if exists reclamaciones_limite_envios on public.reclamaciones_solicitudes;
create trigger reclamaciones_limite_envios
  before insert on public.reclamaciones_solicitudes
  for each row execute function public.reclamaciones_limitar_envios();

drop trigger if exists reclamaciones_limite_envios on public.reclamaciones_consultas;
create trigger reclamaciones_limite_envios
  before insert on public.reclamaciones_consultas
  for each row execute function public.reclamaciones_limitar_envios();

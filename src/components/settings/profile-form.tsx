'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { ecovitUrl } from '@/lib/ecovit/ingreso';
import { SettingsPanelHead } from './settings-panel-head';
import { BrowserNotificationsCard } from './browser-notifications-card';

/**
 * Tu perfil, de solo lectura.
 *
 * El nombre, el correo y la contraseña son los de ECOVIT (`perfiles` y Auth):
 * `profiles` es un espejo que solo escribe la base. wacrm dejaba cambiarlos
 * acá; hacerlo cambiaría la cuenta de ECOVIT por la puerta de atrás, y el
 * nombre ni siquiera se puede escribir (la base no da ese permiso).
 *
 * TODO bloque 5: la foto. El bucket `avatars` es privado desde la migración
 * 110; subirla va por una acción de servidor que compruebe el rol y se lee por
 * enlace firmado. Mientras tanto no se sube.
 */
export function ProfileForm() {
  const { profile, accountRole } = useAuth();
  const ecovit = ecovitUrl();

  const nombre = profile?.full_name || profile?.email || '';
  const inicial = (nombre || 'U').charAt(0).toUpperCase();
  const rol =
    accountRole === 'owner' || accountRole === 'admin'
      ? 'Dirección'
      : accountRole === 'agent'
        ? 'Vendedor'
        : '—';

  return (
    <section>
      <SettingsPanelHead
        title="Tu perfil"
        description="Tu nombre, tu correo y tu contraseña son los de ECOVIT y se cambian allá."
      />
      <Card>
        <CardContent className="flex items-center gap-4">
          <Avatar size="lg" className="size-14">
            {profile?.avatar_url ? <AvatarImage src={profile.avatar_url} alt={nombre} /> : null}
            <AvatarFallback className="bg-primary/10 text-xl text-primary">{inicial}</AvatarFallback>
          </Avatar>
          <dl className="grid min-w-0 flex-1 gap-1 text-sm">
            <div className="truncate font-semibold text-foreground">{nombre}</div>
            <div className="truncate text-muted-foreground">{profile?.email}</div>
            <div className="text-muted-foreground">Rol: {rol}</div>
          </dl>
          {ecovit && (
            <a
              href={ecovit}
              className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Abrir ECOVIT
            </a>
          )}
        </CardContent>
      </Card>
      <BrowserNotificationsCard className="mt-6" />
    </section>
  );
}

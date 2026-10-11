import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth/auth.guards';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Ingresar · Suplente digital',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/login/login').then((m) => m.Login),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'aprobaciones' },
      {
        path: 'aprobaciones',
        title: 'Aprobaciones · Suplente digital',
        loadComponent: () => import('./features/approvals/approvals').then((m) => m.Approvals),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];

/** "Fri 17:52", or just "17:52" today: when something happened, as the review rail and the Activity tab show it. */
export function shortWhen(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

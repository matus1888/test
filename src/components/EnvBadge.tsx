/** Метка окружения на страницах: «БУМАГА» (синяя) или «РЕАЛЬНЫЕ ДЕНЬГИ» (красная). */
export default function EnvBadge({
  kind,
  label,
  title,
}: {
  kind: 'paper' | 'real';
  label: string;
  title?: string;
}) {
  return <span className={`env-badge ${kind}`} title={title}>{label}</span>;
}

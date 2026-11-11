/* Same artwork and live-text placement as the prototype's certificate (css/certificate.css). */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const nameSize = (name: string) => Math.max(2.4, Math.min(4.9, 56 / (Math.max(1, name.length) * 0.56)));
const courseSize = (course: string) => {
  const width = Math.max(1, course.length) * 0.54;
  const oneLine = 54 / width;
  return oneLine >= 1.7 ? Math.min(2.45, oneLine) : Math.max(1.3, Math.min(1.7, 108 / width));
};
const formatDate = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

export function Certificate({ name, course, submitted }: { name: string; course: string; submitted: string }) {
  return (
    <>
      <p className="tc-cert-caption">SAMPLE · NOT AN OFFICIAL CERTIFICATE</p>
      <figure className="tc-certificate" role="group" aria-label="Certificate of Assessment">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/certificate-template.png" alt="" />
        <p className="sr-only">TrainCheck by Finvasia. Certificate of Assessment. This is to certify that</p>
        <h3 className="tc-cert-name" style={{ "--tc-size": `${nameSize(name).toFixed(2)}cqw` } as React.CSSProperties}>
          {name}
        </h3>
        <p className="sr-only">has successfully completed the knowledge assessment for</p>
        <p className="tc-cert-course" style={{ "--tc-size": `${courseSize(course).toFixed(2)}cqw` } as React.CSSProperties}>
          {course}
        </p>
        <time className="tc-cert-date" dateTime={submitted.slice(0, 10)}>
          {formatDate(submitted)}
        </time>
      </figure>
    </>
  );
}

import type { SVGProps } from 'react';

// The Mr. Scotty mark: a transporter beam. Used for the Site Setup entry
// and the empty Activity tab.
const beamPaths = (
  <>
    <path d="M12 2v6" />
    <path d="M5.5 10.5 12 8l6.5 2.5" />
    <path d="M4 13.5c0 4.5 3.6 8 8 8s8-3.5 8-8l-8-3-8 3Z" />
    <path d="M12 10.5v11" />
  </>
);

export default function BeamIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {beamPaths}
    </svg>
  );
}

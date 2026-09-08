"use client";

import React, { useEffect, useRef, useState } from "react";
import { Wrapper } from "@googlemaps/react-wrapper";

interface StreetViewViewerProps {
  apiKey: string;
  latitude: number;
  longitude: number;
  heading?: number;
  onEnterProperty: () => void;
}

const StreetViewInner: React.FC<Omit<StreetViewViewerProps, "apiKey">> = ({
  latitude,
  longitude,
  heading = 0,
  onEnterProperty,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const panoramaRef = useRef<google.maps.StreetViewPanorama | null>(null);

  useEffect(() => {
    if (containerRef.current && !panoramaRef.current) {
      panoramaRef.current = new window.google.maps.StreetViewPanorama(
        containerRef.current,
        {
          position: { lat: latitude, lng: longitude },
          pov: { heading: heading, pitch: 0 },
          zoom: 1,
          addressControl: false,
          showRoadLabels: false,
          linksControl: true,
          panControl: true,
          enableCloseButton: false,
          fullscreenControl: false,
        }
      );
    }
  }, [latitude, longitude, heading]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {/* Street View Container */}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* Enter Property Overlay Button */}
      <div
        style={{
          position: "absolute",
          bottom: "40px",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 10,
        }}
      >
        <button
          onClick={onEnterProperty}
          style={{
            backgroundColor: "#7e22ce", // Tailwind purple-700
            color: "white",
            padding: "16px 32px",
            fontSize: "1.125rem",
            fontWeight: "bold",
            borderRadius: "9999px", // Full rounded
            border: "none",
            cursor: "pointer",
            boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
            transition: "transform 0.2s, background-color 0.2s",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#6b21a8")} // purple-800
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#7e22ce")} // purple-700
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 3h6v6" />
            <path d="M9 21H3v-6" />
            <path d="M21 3l-7 7" />
            <path d="M3 21l7-7" />
          </svg>
          Enter Property
        </button>
      </div>
    </div>
  );
};

export const StreetViewViewer: React.FC<StreetViewViewerProps> = (props) => {
  const [error, setError] = useState<string | null>(null);

  if (!props.apiKey) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-gray-900 text-white flex-col gap-4">
        <p className="text-xl">Google Maps API Key is missing.</p>
        <p className="text-sm text-gray-400">Please configure NEXT_PUBLIC_GOOGLE_MAPS_API_KEY in your environment.</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative bg-black">
      <Wrapper apiKey={props.apiKey} version="weekly" libraries={["places"]}>
        <StreetViewInner {...props} />
      </Wrapper>
    </div>
  );
};

export default StreetViewViewer;

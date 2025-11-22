// components/Loading.tsx
import React from "react";
import { Loader2 } from "lucide-react";

interface LoadingProps {
  text?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const Loading: React.FC<LoadingProps> = ({ 
  text = "Loading...", 
  size = "md",
  className = ""
}) => {
  const sizeClasses = {
    sm: "w-6 h-6",
    md: "w-10 h-10",
    lg: "w-16 h-16"
  };

  return (
    <div className={`flex flex-col items-center justify-center min-h-screen bg-gray-950 text-white ${className}`}>
      <Loader2 className={`${sizeClasses[size]} animate-spin text-blue-500`} />
      <p className="mt-6 text-lg font-medium animate-pulse">
        {text}
      </p>
    </div>
  );
};

export default Loading;
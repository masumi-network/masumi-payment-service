import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';

interface SidebarContextType {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  isHovered: boolean;
  setIsHovered: (hovered: boolean) => void;
  shouldAnimateIcon: boolean;
  hasAnimatedNav: boolean;
  markNavAnimated: () => void;
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined);

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsedState] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('sidebarCollapsed');
      return saved ? JSON.parse(saved) : false;
    }
    return false;
  });
  const [isHovered, setIsHovered] = useState(false);
  const [shouldAnimateIcon, setShouldAnimateIcon] = useState(false);
  const [hasAnimatedNav, setHasAnimatedNav] = useState(false);
  const prevCollapsedRef = useRef(collapsed);
  const prevHoveredRef = useRef(isHovered);

  // Persist collapsed state to localStorage
  useEffect(() => {
    localStorage.setItem('sidebarCollapsed', JSON.stringify(collapsed));
  }, [collapsed]);

  // Handle icon animation when collapsing or hover ends
  useEffect(() => {
    const isCollapsing = collapsed && !prevCollapsedRef.current;
    const isHoverEnding = collapsed && !isHovered && prevHoveredRef.current;

    if (isCollapsing || isHoverEnding) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Animation state must be set synchronously to coordinate with setTimeout cleanup
      setShouldAnimateIcon(true);
      const timer = setTimeout(() => {
        setShouldAnimateIcon(false);
      }, 300);
      prevCollapsedRef.current = collapsed;
      prevHoveredRef.current = isHovered;
      return () => clearTimeout(timer);
    }

    prevCollapsedRef.current = collapsed;
    prevHoveredRef.current = isHovered;
  }, [collapsed, isHovered]);

  const setCollapsed = useCallback((value: boolean) => {
    setCollapsedState(value);
  }, []);

  const markNavAnimated = useCallback(() => {
    setHasAnimatedNav(true);
  }, []);

  const value: SidebarContextType = {
    collapsed,
    setCollapsed,
    isHovered,
    setIsHovered,
    shouldAnimateIcon,
    hasAnimatedNav,
    markNavAnimated,
  };

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (context === undefined) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return context;
}

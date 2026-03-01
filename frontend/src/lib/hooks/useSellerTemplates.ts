import { useState, useCallback } from 'react';

const STORAGE_KEY = 'invoice-seller-templates';

export interface SellerTemplateData {
  name: string | null;
  companyName: string | null;
  vatNumber: string | null;
  country: string;
  city: string;
  zipCode: string;
  street: string;
  streetNumber: string;
  email: string | null;
  phone: string | null;
}

export interface SellerTemplate {
  id: string;
  label: string;
  seller: SellerTemplateData;
}

function loadTemplates(): SellerTemplate[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SellerTemplate[];
  } catch {
    return [];
  }
}

function persistTemplates(templates: SellerTemplate[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

export function useSellerTemplates() {
  const [templates, setTemplates] = useState<SellerTemplate[]>(loadTemplates);

  const save = useCallback((label: string, seller: SellerTemplateData): SellerTemplate => {
    const id = `tpl_${Date.now()}`;
    const template: SellerTemplate = { id, label, seller };
    setTemplates((prev) => {
      const next = [...prev, template];
      persistTemplates(next);
      return next;
    });
    return template;
  }, []);

  const update = useCallback((id: string, label: string, seller: SellerTemplateData) => {
    setTemplates((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, label, seller } : t));
      persistTemplates(next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setTemplates((prev) => {
      const next = prev.filter((t) => t.id !== id);
      persistTemplates(next);
      return next;
    });
  }, []);

  return { templates, save, update, remove };
}

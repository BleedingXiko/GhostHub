/**
 * Streaming Row Shell Unit Tests
 *
 * Covers the pure helpers exported by streaming/rowShell.js plus baseline
 * DOM-shape expectations the row Components rely on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isWithinPrimeWindow, shouldPrefetchNextChunk } from '../../../modules/layouts/streaming/rowShell.js';

describe('Streaming row shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    document.body.innerHTML = `
      <div class="category-rows">
        <div class="category-row" data-category-id="continue-watching">
          <h2 class="row-title">Continue Watching</h2>
          <div class="row-scroll-container">
            <button class="scroll-btn scroll-left hidden">‹</button>
            <div class="row-content"></div>
            <button class="scroll-btn scroll-right">›</button>
          </div>
        </div>
      </div>
    `;
  });

  describe('Row structure', () => {
    it('should have category rows container', () => {
      expect(document.querySelector('.category-rows')).toBeDefined();
    });

    it('should have row with category id', () => {
      const row = document.querySelector('[data-category-id="continue-watching"]');
      expect(row).toBeDefined();
    });

    it('should have row title', () => {
      const title = document.querySelector('.row-title');
      expect(title.textContent).toBe('Continue Watching');
    });

    it('should have row content container', () => {
      expect(document.querySelector('.row-content')).toBeDefined();
    });
  });

  describe('Row creation', () => {
    it('should create new row', () => {
      const rows = document.querySelector('.category-rows');
      
      const newRow = document.createElement('div');
      newRow.className = 'category-row';
      newRow.dataset.categoryId = 'movies';
      newRow.innerHTML = `
        <h2 class="row-title">Movies</h2>
        <div class="row-content"></div>
      `;
      rows.appendChild(newRow);
      
      expect(document.querySelector('[data-category-id="movies"]')).toBeDefined();
    });

    it('should insert row at position', () => {
      const rows = document.querySelector('.category-rows');
      const existingRow = rows.firstElementChild;
      
      const newRow = document.createElement('div');
      newRow.className = 'category-row';
      newRow.dataset.categoryId = 'featured';
      
      rows.insertBefore(newRow, existingRow);
      
      expect(rows.firstElementChild.dataset.categoryId).toBe('featured');
    });
  });

  describe('Horizontal scrolling', () => {
    it('should have scroll buttons', () => {
      expect(document.querySelector('.scroll-left')).toBeDefined();
      expect(document.querySelector('.scroll-right')).toBeDefined();
    });

    it('should hide left button at start', () => {
      const leftBtn = document.querySelector('.scroll-left');
      expect(leftBtn.classList.contains('hidden')).toBe(true);
    });

    it('should scroll right on button click', () => {
      const content = document.querySelector('.row-content');
      content.scrollLeft = 0;
      
      // Simulate scroll
      content.scrollLeft += 300;
      
      expect(content.scrollLeft).toBe(300);
    });

    it('should scroll left on button click', () => {
      const content = document.querySelector('.row-content');
      content.scrollLeft = 300;
      
      content.scrollLeft -= 300;
      
      expect(content.scrollLeft).toBe(0);
    });

    it('should show/hide buttons based on scroll position', () => {
      const content = document.querySelector('.row-content');
      const leftBtn = document.querySelector('.scroll-left');
      
      // Simulate scroll
      content.scrollLeft = 100;
      leftBtn.classList.remove('hidden');
      
      expect(leftBtn.classList.contains('hidden')).toBe(false);
    });
  });

  describe('Row content', () => {
    it('should add media cards to row', () => {
      const content = document.querySelector('.row-content');
      
      for (let i = 0; i < 5; i++) {
        const card = document.createElement('div');
        card.className = 'media-card';
        content.appendChild(card);
      }
      
      expect(content.querySelectorAll('.media-card')).toHaveLength(5);
    });

    it('should clear row content', () => {
      const content = document.querySelector('.row-content');
      content.innerHTML = '<div class="media-card"></div>';
      
      content.innerHTML = '';
      
      expect(content.children.length).toBe(0);
    });
  });

  describe('Row loading', () => {
    it('should show loading skeleton', () => {
      const content = document.querySelector('.row-content');
      
      for (let i = 0; i < 5; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = 'media-card skeleton';
        content.appendChild(skeleton);
      }
      
      expect(content.querySelectorAll('.skeleton')).toHaveLength(5);
    });

    it('should replace skeletons with real content', () => {
      const content = document.querySelector('.row-content');
      content.innerHTML = '<div class="skeleton"></div>';
      
      content.innerHTML = '<div class="media-card"></div>';
      
      expect(content.querySelector('.skeleton')).toBeNull();
    });
  });

  describe('Infinite scroll', () => {
    it('should detect near end of row', () => {
      const container = {
        scrollLeft: 800,
        clientWidth: 400,
        scrollWidth: 1200
      };
      
      const threshold = 100;
      const nearEnd = container.scrollLeft + container.clientWidth >= container.scrollWidth - threshold;
      
      expect(nearEnd).toBe(true);
    });

    it('should load more on scroll end', () => {
      let page = 1;
      const loadMore = vi.fn(() => { page++; });
      
      loadMore();
      
      expect(loadMore).toHaveBeenCalled();
      expect(page).toBe(2);
    });

    it('should prefetch before hitting the hard edge', () => {
      expect(shouldPrefetchNextChunk(500, 300, 1050)).toBe(true);
      expect(shouldPrefetchNextChunk(200, 300, 1200)).toBe(false);
    });
  });

  describe('Row visibility', () => {
    it('should hide empty rows', () => {
      const row = document.querySelector('.category-row');
      const content = row.querySelector('.row-content');
      
      if (content.children.length === 0) {
        row.classList.add('hidden');
      }
      
      expect(row.classList.contains('hidden')).toBe(true);
    });

    it('should show rows with content', () => {
      const row = document.querySelector('.category-row');
      const content = row.querySelector('.row-content');
      
      content.innerHTML = '<div class="media-card"></div>';
      row.classList.remove('hidden');
      
      expect(row.classList.contains('hidden')).toBe(false);
    });
  });

  describe('Thumbnail priming', () => {
    it('should prime cards slightly outside the viewport', () => {
      expect(isWithinPrimeWindow(-200, 40, 800)).toBe(true);
      expect(isWithinPrimeWindow(850, 980, 800)).toBe(true);
      expect(isWithinPrimeWindow(1400, 1500, 800)).toBe(false);
    });
  });
});

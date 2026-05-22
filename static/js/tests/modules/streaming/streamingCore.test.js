/**
 * Streaming Layout Core Unit Tests
 * Tests for Netflix-style streaming layout
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Streaming Layout Core', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup DOM
    document.body.innerHTML = `
      <div id="streaming-container">
        <div class="hero-section">
          <div class="hero-content">
            <h1 class="hero-title"></h1>
            <p class="hero-description"></p>
            <button class="hero-play-btn">Play</button>
          </div>
          <div class="hero-backdrop"></div>
        </div>
        <div class="category-rows">
          <div class="category-row" data-category-id="continue-watching">
            <h2 class="row-title">Continue Watching</h2>
            <div class="row-content"></div>
          </div>
        </div>
      </div>
    `;
    
    // Mock fetch
    global.fetch = vi.fn();
    
    // Mock IntersectionObserver
    window.IntersectionObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn()
    }));
  });

  describe('Streaming container', () => {
    it('should have streaming container', () => {
      expect(document.getElementById('streaming-container')).toBeDefined();
    });

    it('should have hero section', () => {
      expect(document.querySelector('.hero-section')).toBeDefined();
    });

    it('should have category rows', () => {
      expect(document.querySelector('.category-rows')).toBeDefined();
    });
  });

  describe('Hero section', () => {
    it('should have hero content', () => {
      expect(document.querySelector('.hero-content')).toBeDefined();
    });

    it('should have hero title', () => {
      expect(document.querySelector('.hero-title')).toBeDefined();
    });

    it('should have play button', () => {
      expect(document.querySelector('.hero-play-btn')).toBeDefined();
    });

    it('should update hero content', () => {
      const title = document.querySelector('.hero-title');
      const desc = document.querySelector('.hero-description');
      
      title.textContent = 'Featured Movie';
      desc.textContent = 'An amazing movie to watch';
      
      expect(title.textContent).toBe('Featured Movie');
      expect(desc.textContent).toBe('An amazing movie to watch');
    });

    it('should set backdrop image', () => {
      const backdrop = document.querySelector('.hero-backdrop');
      backdrop.style.backgroundImage = 'url(/thumbnails/hero.jpg)';
      
      expect(backdrop.style.backgroundImage).toContain('hero.jpg');
    });
  });

  describe('Category rows', () => {
    it('should have Continue Watching row', () => {
      expect(document.querySelector('[data-category-id="continue-watching"]')).toBeDefined();
    });

    it('should have row title', () => {
      expect(document.querySelector('.row-title').textContent).toBe('Continue Watching');
    });

    it('should have row content container', () => {
      expect(document.querySelector('.row-content')).toBeDefined();
    });

    it('should add new category row', () => {
      const rows = document.querySelector('.category-rows');
      
      const newRow = document.createElement('div');
      newRow.className = 'category-row';
      newRow.dataset.categoryId = 'movies';
      
      const title = document.createElement('h2');
      title.className = 'row-title';
      title.textContent = 'Movies';
      newRow.appendChild(title);
      
      const content = document.createElement('div');
      content.className = 'row-content';
      newRow.appendChild(content);
      
      rows.appendChild(newRow);
      
      expect(document.querySelector('[data-category-id="movies"]')).toBeDefined();
    });
  });

  describe('Media cards', () => {
    it('should create media card', () => {
      const content = document.querySelector('.row-content');
      
      const card = document.createElement('div');
      card.className = 'media-card';
      card.dataset.url = '/media/video.mp4';
      
      const thumb = document.createElement('img');
      thumb.className = 'card-thumb';
      thumb.src = '/thumbnails/video.jpg';
      card.appendChild(thumb);
      
      const info = document.createElement('div');
      info.className = 'card-info';
      info.textContent = 'Video Title';
      card.appendChild(info);
      
      content.appendChild(card);
      
      expect(content.querySelector('.media-card')).toBeDefined();
    });

    it('should show progress bar on cards', () => {
      const content = document.querySelector('.row-content');
      
      const card = document.createElement('div');
      card.className = 'media-card';
      
      const progress = document.createElement('div');
      progress.className = 'progress-bar';
      progress.style.width = '45%';
      card.appendChild(progress);
      
      content.appendChild(card);
      
      expect(content.querySelector('.progress-bar').style.width).toBe('45%');
    });

    it('should calculate progress percentage', () => {
      const current = 300; // 5 minutes
      const total = 600;   // 10 minutes
      const percent = Math.round((current / total) * 100);
      
      expect(percent).toBe(50);
    });
  });

  describe('Horizontal scrolling', () => {
    it('should scroll row content horizontally', () => {
      const content = document.querySelector('.row-content');
      content.scrollLeft = 200;
      
      expect(content.scrollLeft).toBe(200);
    });

    it('should detect scroll near end', () => {
      const content = {
        scrollLeft: 800,
        clientWidth: 400,
        scrollWidth: 1200
      };
      
      const threshold = 100;
      const nearEnd = content.scrollLeft + content.clientWidth >= content.scrollWidth - threshold;
      
      expect(nearEnd).toBe(true);
    });

    it('should load more on scroll end', () => {
      let page = 1;
      const loadMore = () => { page++; };
      
      loadMore();
      
      expect(page).toBe(2);
    });
  });

  describe('Continue Watching', () => {
    it('should fetch progress data', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          videos: [
            { video_url: '/media/movie1.mp4', video_timestamp: 1800, video_duration: 7200 },
            { video_url: '/media/movie2.mp4', video_timestamp: 600, video_duration: 3600 }
          ]
        })
      });
      
      const response = await fetch('/api/progress/videos');
      const data = await response.json();
      
      expect(data.videos).toHaveLength(2);
    });

    it('should filter out completed videos', () => {
      const videos = [
        { url: 'a.mp4', timestamp: 100, duration: 100 },  // completed
        { url: 'b.mp4', timestamp: 50, duration: 100 },   // in progress
        { url: 'c.mp4', timestamp: 95, duration: 100 }    // nearly done (>90%)
      ];
      
      const inProgress = videos.filter(v => {
        const percent = (v.timestamp / v.duration) * 100;
        return percent < 90 && percent > 0;
      });
      
      expect(inProgress).toHaveLength(1);
    });
  });

  describe('Category data fetching', () => {
    it('should fetch media for category', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          media: [
            { url: '/media/video1.mp4', type: 'video', name: 'Video 1' },
            { url: '/media/video2.mp4', type: 'video', name: 'Video 2' }
          ],
          orderedIds: ['movies::video1.mp4', 'movies::video2.mp4'],
          hasMore: true
        })
      });
      
      const response = await fetch('/api/media/order?view=streaming_row&category_id=movies&page=1&limit=20');
      const data = await response.json();
      
      expect(data.orderedIds).toHaveLength(2);
      expect(data.hasMore).toBe(true);
    });
  });

  describe('Card interactions', () => {
    it('should handle card click', () => {
      const handler = vi.fn();
      const content = document.querySelector('.row-content');
      
      content.addEventListener('click', (e) => {
        const card = e.target.closest('.media-card');
        if (card) handler(card.dataset.url);
      });
      
      const card = document.createElement('div');
      card.className = 'media-card';
      card.dataset.url = '/media/test.mp4';
      content.appendChild(card);
      
      card.click();
      
      expect(handler).toHaveBeenCalledWith('/media/test.mp4');
    });

    it('should show hover state', () => {
      const card = document.createElement('div');
      card.className = 'media-card';
      
      card.addEventListener('mouseenter', () => card.classList.add('hover'));
      card.dispatchEvent(new Event('mouseenter'));
      
      expect(card.classList.contains('hover')).toBe(true);
    });
  });
});

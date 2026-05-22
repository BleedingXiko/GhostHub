"""GhostHub media discovery controller built on Specter."""

from flask import request

from app.services.media.sort_service import SortService
from specter import Controller, registry
from app.utils.auth import get_show_hidden_flag




class MediaDiscoveryController(Controller):
    """Newest-media and timeline queries for gallery-style browsing."""

    name = 'media_discovery'
    url_prefix = '/api'

    def build_routes(self, router):
        @router.route(
            '/media/newest',
            methods=['GET'],
            json_errors='Failed to get newest media',
        )
        def get_newest_media():
            limit = request.args.get('limit', 10, type=int)
            result = registry.require('media_ordering').get_order(
                'whats_new',
                {
                    'limit': limit,
                    'media_filter': request.args.get('media_filter') or request.args.get('filter') or 'all',
                },
                show_hidden=get_show_hidden_flag(),
            )
            return {
                'orderedIds': result.get('orderedIds') or [],
                'records': {},
                'missing': [],
            }

        @router.route(
            '/media/timeline/years',
            methods=['GET'],
            json_errors='Failed to get timeline years',
        )
        def get_timeline_years():
            result = self.get_timeline_years(
                media_filter=request.args.get('filter', 'all', type=str).lower(),
                category_id=request.args.get('category_id'),
                category_ids=request.args.get('category_ids'),
                show_hidden=get_show_hidden_flag(),
            )
            return {
                'years': result,
                'total_years': len(result),
            }

    def get_timeline_years(
        self,
        *,
        media_filter='all',
        category_id=None,
        category_ids=None,
        show_hidden=False,
    ):
        scoped_category_ids = [
            value.strip()
            for value in str(category_ids or '').split(',')
            if value.strip()
        ]
        if scoped_category_ids:
            date_counts = {}
            for scoped_id in scoped_category_ids:
                scoped_counts = SortService.get_timeline_dates(
                    category_id=scoped_id,
                    filter_type=media_filter,
                    show_hidden=show_hidden,
                )
                for date_key, count in scoped_counts.items():
                    date_counts[date_key] = date_counts.get(date_key, 0) + count
        else:
            date_counts = SortService.get_timeline_dates(
                category_id=category_id,
                filter_type=media_filter,
                show_hidden=show_hidden,
            )

        years_data = {}
        for date_key, count in date_counts.items():
            try:
                year = int(date_key.split('-')[0])
                month = int(date_key.split('-')[1])
            except (ValueError, IndexError):
                continue

            if year not in years_data:
                years_data[year] = {
                    'months': set(),
                    'count': 0,
                    'first_date': date_key,
                    'month_dates': {},
                    'month_counts': {},
                }

            years_data[year]['months'].add(month)
            years_data[year]['count'] += count
            years_data[year]['month_counts'][month] = (
                years_data[year]['month_counts'].get(month, 0) + count
            )
            if (
                month not in years_data[year]['month_dates'] or
                date_key > years_data[year]['month_dates'][month]
            ):
                years_data[year]['month_dates'][month] = date_key
            if date_key < years_data[year]['first_date']:
                years_data[year]['first_date'] = date_key

        result = []
        for year in sorted(years_data.keys(), reverse=True):
            data = years_data[year]
            months = [{
                'month': month,
                'dateKey': data['month_dates'].get(month),
                'media_count': data['month_counts'].get(month, 0),
            } for month in sorted(list(data['months']), reverse=True)]
            result.append({
                'year': year,
                'month_count': len(data['months']),
                'media_count': data['count'],
                'first_date': data['first_date'],
                'months': months,
            })

        return result

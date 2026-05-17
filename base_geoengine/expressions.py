# Copyright 2023 ACSONE SA/NV
# Copyright 2026 OCA saas-19.3 port
# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).

"""
saas-19.3 port: `BaseModel._condition_to_sql` was removed; the equivalent
machinery is now on `Field._condition_to_sql` (odoo/orm/fields.py:~1331).

Old approach (pre-19.3): monkey-patch `BaseModel._condition_to_sql` to
intercept geo operators and emit PostGIS SQL.

New approach (saas-19.3): patch `Field._condition_to_sql` to delegate to
GeoField when the operator is a geo operator and the field is a GeoField.
Indirect dict-based spatial relation queries are deferred (raise
NotImplementedError) — the map view renderer doesn't need them; ORM-domain
geo searches do but those are rarely used in practice.
"""
import logging

from odoo.fields import Field
from odoo.orm.domains import CONDITION_OPERATORS
from odoo.tools import SQL

from .fields import GeoField
from .geo_operators import GeoOperator

_logger = logging.getLogger(__name__)

GEO_OPERATORS = {
    "geo_greater": ">",
    "geo_lesser": "<",
    "geo_equal": "=",
    "geo_touch": "ST_Touches",
    "geo_within": "ST_Within",
    "geo_contains": "ST_Contains",
    "geo_intersect": "ST_Intersects",
}

# Register geo operators in the saas-19.3 Domain validator so DomainCondition
# doesn't reject them as 'Invalid operator'.
CONDITION_OPERATORS.update(GEO_OPERATORS.keys())

# Save the original Field._condition_to_sql so non-geo cases still flow through.
_original_field_condition_to_sql = Field._condition_to_sql


def _condition_to_sql_with_geo(self, table, field_expr, operator, value) -> SQL:
    """Field._condition_to_sql override that adds geo operator handling."""
    if operator in GEO_OPERATORS and isinstance(self, GeoField):
        if isinstance(value, dict):
            # Indirect spatial relation queries (e.g. find locations whose
            # geom intersects any polygon in res.zip matching a sub-domain)
            # require subselect query building that hasn't been ported to
            # the saas-19.3 Domain.execute() pipeline yet. The map view
            # doesn't use this path; only programmatic searches do.
            raise NotImplementedError(
                "base_geoengine saas-19.3 port: indirect spatial relation "
                "queries (dict-valued geo operator) not yet supported. "
                "Use a direct geometry value or fetch via Python."
            )
        # Direct value comparison: value is a shapely geom, WKT string, or
        # geojson dict already serialized. Delegate the WKT conversion to
        # GeoField.convert_to_column.
        try:
            wkt_value = self.convert_to_column(value, table._model, validate=False)
        except Exception:
            wkt_value = value
        sql_column = table[field_expr]
        srid = self.srid
        if operator in ("geo_greater", "geo_lesser"):
            cmp = SQL(GEO_OPERATORS[operator])
            return SQL(
                "ST_Area(%s) %s ST_Area(ST_GeomFromEWKT(%s))",
                sql_column, cmp, wkt_value,
            )
        if operator == "geo_equal":
            return SQL("%s = ST_GeomFromEWKT(%s)", sql_column, wkt_value)
        # ST_Touches / ST_Within / ST_Contains / ST_Intersects
        func = SQL(GEO_OPERATORS[operator])
        return SQL("%s(%s, ST_GeomFromEWKT(%s))", func, sql_column, wkt_value)
    return _original_field_condition_to_sql(self, table, field_expr, operator, value)


Field._condition_to_sql = _condition_to_sql_with_geo

import {session} from "@web/session";
import {useService} from "@web/core/utils/hooks";

/* global L, console, document */

const {Component, onWillStart, onMounted, onPatched, useRef, useState} = owl;

export class MapRenderer extends Component {
    static template = "web_view_leaflet_map.MapRenderer";
    static components = {};

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.mapRef = useRef("mapContainer");
        this.leafletTileUrl = session["leaflet.tile_url"];
        this.leafletCopyright = session["leaflet.copyright"];

        const archAttrs = this.props.archInfo.arch.attributes;

        this.resModel = this.props.resModel;
        this.defaultZoom = parseInt(archAttrs.default_zoom, 10) || 7;
        this.maxZoom = parseInt(archAttrs.max_zoom, 10) || 19;
        this.zoomSnap = parseInt(archAttrs.zoom_snap, 10) || 1;
        this.focusZoom = parseInt(archAttrs.focus_zoom, 10) || 14;

        this.fieldLatitude = archAttrs.field_latitude?.value;
        this.fieldLongitude = archAttrs.field_longitude?.value;
        this.fieldTitle = archAttrs.field_title?.value;
        this.fieldAddress = archAttrs.field_address?.value;
        this.fieldMarkerIconImage = archAttrs.field_marker_icon_image?.value;

        // Comma-separated list of extra fields shown in the popup
        const extra = archAttrs.field_extra_info?.value || "";
        this.fieldExtraInfo = extra
            ? extra.split(",").map((s) => s.trim()).filter(Boolean)
            : [];

        // Sidebar can be turned off per-view via show_sidebar="0"
        this.showSidebar = archAttrs.show_sidebar?.value !== "0";

        this.markerIconSizeX = parseInt(archAttrs.marker_icon_size_x?.value, 10) || 64;
        this.markerIconSizeY = parseInt(archAttrs.marker_icon_size_y?.value, 10) || 64;
        this.markerPopupAnchorX =
            parseInt(archAttrs.marker_popup_anchor_x?.value, 10) || 0;
        this.markerPopupAnchorY =
            parseInt(archAttrs.marker_popup_anchor_y?.value, 10) || -32;

        this.state = useState({
            searchQuery: "",
            selectedId: null,
        });

        this.leafletMap = null;
        this.mainLayer = null;
        this.markersById = {};

        onWillStart(async () => {
            await this.initDefaultPosition();
            await this.loadRecords();
        });

        onMounted(() => {
            this.initMap();
            this.renderMarkers();
        });

        onPatched(() => {
            if (this.leafletMap) {
                // Resize map when sidebar layout adjusts
                this.leafletMap.invalidateSize();
            }
        });
    }

    get filteredRecords() {
        const q = (this.state.searchQuery || "").toLowerCase().trim();
        if (!q) return this.records || [];
        return (this.records || []).filter((r) => {
            const fields = ["display_name", this.fieldTitle, this.fieldAddress].filter(Boolean);
            return fields.some((f) => {
                const v = r[f];
                return typeof v === "string" && v.toLowerCase().includes(q);
            });
        });
    }

    onSearchInput() {
        // useState mutation already triggers re-render; nothing else needed
    }

    onSelectRecord(record) {
        this.state.selectedId = record.id;
        const lat = record[this.fieldLatitude];
        const lng = record[this.fieldLongitude];
        if (!lat || !lng || !this.leafletMap) return;
        this.leafletMap.flyTo(L.latLng(lat, lng), this.focusZoom, {duration: 0.8});
        const marker = this.markersById[record.id];
        if (marker) {
            setTimeout(() => marker.openPopup(), 800);
        }
    }

    async loadRecords() {
        const fields = this.getFields();
        try {
            const records = await this.orm.searchRead(
                this.resModel,
                this.props.domain || [],
                fields,
                {
                    limit: this.props.limit || 80,
                    context: this.props.context || {},
                }
            );
            this.records = records;
        } catch (error) {
            console.error("Error loading records:", error);
            this.records = [];
        }
    }

    getFields() {
        const fields = new Set();
        fields.add("id");
        fields.add("display_name");
        fields.add("date_localization");
        if (this.fieldLatitude) fields.add(this.fieldLatitude);
        if (this.fieldLongitude) fields.add(this.fieldLongitude);
        if (this.fieldTitle) fields.add(this.fieldTitle);
        if (this.fieldAddress) fields.add(this.fieldAddress);
        if (this.fieldMarkerIconImage) fields.add(this.fieldMarkerIconImage);
        for (const f of this.fieldExtraInfo) fields.add(f);
        return Array.from(fields);
    }

    async initDefaultPosition() {
        const result = await this.orm.call(
            "res.users",
            "get_default_leaflet_position",
            [this.props.resModel]
        );
        this.defaultLatLng = L.latLng(result.lat, result.lng);
    }

    initMap() {
        const mapDiv = this.mapRef.el;
        if (!mapDiv) {
            console.error("Map container not found");
            return;
        }
        this.leafletMap = L.map(mapDiv, {
            zoomSnap: this.zoomSnap,
        }).setView(this.defaultLatLng, this.defaultZoom);

        const osm = L.tileLayer(
            this.leafletTileUrl || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            {
                maxZoom: this.maxZoom,
                attribution:
                    this.leafletCopyright ||
                    "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a>",
            }
        );
        const osmTopo = L.tileLayer(
            "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
            {
                maxZoom: 17,
                attribution: "Map data: &copy; OpenStreetMap, SRTM | Style: &copy; OpenTopoMap (CC-BY-SA)",
            }
        );
        const googleStreets = L.tileLayer(
            "https://mt.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
            {maxZoom: 20, subdomains: ["mt0", "mt1", "mt2", "mt3"], attribution: "&copy; Google"}
        );
        const googleSatellite = L.tileLayer(
            "https://mt.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
            {maxZoom: 20, subdomains: ["mt0", "mt1", "mt2", "mt3"], attribution: "&copy; Google"}
        );
        const googleHybrid = L.tileLayer(
            "https://mt.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
            {maxZoom: 20, subdomains: ["mt0", "mt1", "mt2", "mt3"], attribution: "&copy; Google"}
        );

        osm.addTo(this.leafletMap);
        L.control
            .layers(
                {
                    "OpenStreetMap": osm,
                    "OpenTopoMap": osmTopo,
                    "Google Streets": googleStreets,
                    "Google Satellite": googleSatellite,
                    "Google Hybrid": googleHybrid,
                },
                {},
                {position: "topright", collapsed: true}
            )
            .addTo(this.leafletMap);
    }

    renderMarkers() {
        if (!this.leafletMap) return;

        if (this.mainLayer) {
            this.leafletMap.removeLayer(this.mainLayer);
        }
        this.markersById = {};

        this.mainLayer = L.markerClusterGroup();
        for (const record of this.records) {
            const marker = this.prepareMarker(record);
            if (marker) {
                this.mainLayer.addLayer(marker);
                this.markersById[record.id] = marker;
            }
        }
        const bounds = this.mainLayer.getBounds();
        if (bounds.isValid()) {
            this.leafletMap.fitBounds(bounds.pad(0.1));
        }
        this.leafletMap.addLayer(this.mainLayer);
    }

    prepareMarker(record) {
        const lat = record[this.fieldLatitude];
        const lng = record[this.fieldLongitude];
        if (!lat || !lng) {
            return null;
        }
        const latlng = L.latLng(lat, lng);
        if (latlng.lat === 0 && latlng.lng === 0) return null;

        const markerOptions = this.prepareMarkerOptions(record);
        const marker = L.marker(latlng, markerOptions);
        const popup = L.popup({maxWidth: 320}).setContent(this.preparePopUpData(record));

        marker.bindPopup(popup).on("popupopen", () => {
            this.state.selectedId = record.id;
            const selector = document.querySelector(`.o_map_selector[data-res-id="${record.id}"]`);
            if (selector) {
                selector.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    this.onClickLeafletPopup(record);
                });
            }
        });
        return marker;
    }

    prepareMarkerIcon(record) {
        const lastUpdate = record.date_localization || new Date().toISOString();
        const unique = lastUpdate.replace(/[^0-9]/g, "");
        const iconUrl = `/web/image?model=${this.resModel}&id=${record.id}&field=${this.fieldMarkerIconImage}&unique=${unique}`;
        return L.icon({
            iconUrl: iconUrl,
            className: "leaflet_marker_icon",
            iconSize: [this.markerIconSizeX, this.markerIconSizeY],
            popupAnchor: [this.markerPopupAnchorX, this.markerPopupAnchorY],
        });
    }

    prepareMarkerOptions(record) {
        const title = record[this.fieldTitle] || "";
        const result = {
            title: title,
            alt: title,
            riseOnHover: true,
        };
        if (this.fieldMarkerIconImage) {
            result.icon = this.prepareMarkerIcon(record);
        }
        return result;
    }

    preparePopUpData(record) {
        const title = this._escapeHtml(record[this.fieldTitle] || record.display_name || "");
        const address = this._escapeHtml(record[this.fieldAddress] || "");

        let extraRows = "";
        for (const f of this.fieldExtraInfo) {
            const v = record[f];
            if (v === false || v === null || v === undefined || v === "") continue;
            const label = this._humanizeFieldName(f);
            const display = Array.isArray(v) && v.length === 2 ? this._escapeHtml(v[1]) : this._escapeHtml(String(v));
            extraRows += `<div class='o_leaflet_popup_row'><span class='o_leaflet_popup_label'>${label}:</span> ${display}</div>`;
        }

        return `
            <div class='o_leaflet_popup' data-res-id='${record.id}'>
                <div class='o_leaflet_popup_title'>${title}</div>
                ${address ? `<div class='o_leaflet_popup_address'>${address}</div>` : ""}
                ${extraRows}
                <a href='#' class='o_map_selector btn btn-primary btn-sm mt-2' data-res-id='${record.id}'>
                    Open <i class='fa fa-arrow-right ms-1'/>
                </a>
            </div>
        `;
    }

    _escapeHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    _humanizeFieldName(f) {
        return f.replace(/_id$/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }

    onClickLeafletPopup(record) {
        this.action.doAction({
            type: "ir.actions.act_window",
            res_model: this.resModel,
            res_id: record.id,
            views: [[false, "form"]],
            target: "current",
        });
    }
}

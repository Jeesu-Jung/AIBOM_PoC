from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Integer, JSON, Numeric, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class ModelInfo(Base):
    __tablename__ = "model_info"

    model_id: Mapped[str] = mapped_column(String(512), primary_key=True)
    namespace: Mapped[str] = mapped_column(String(255))
    model_name: Mapped[str] = mapped_column(String(255))
    family_key: Mapped[str] = mapped_column(String(100))
    family_name: Mapped[str] = mapped_column(String(255))
    model_role: Mapped[str] = mapped_column(String(20))
    supplier: Mapped[str | None] = mapped_column(String(255))
    family_developer: Mapped[str | None] = mapped_column(String(255))
    family_release_date: Mapped[date | None] = mapped_column(Date)
    family_license_name: Mapped[str | None] = mapped_column(String(255))
    primary_purpose: Mapped[str | None] = mapped_column(String(255))
    model_version: Mapped[str | None] = mapped_column(String(255))
    package_url: Mapped[str | None] = mapped_column(String(1000))
    model_url: Mapped[str] = mapped_column(String(1000))
    license_reported: Mapped[Any | None] = mapped_column(JSON)
    artifact_format: Mapped[str | None] = mapped_column(String(100))
    tensor_type: Mapped[str | None] = mapped_column(String(100))
    parameter_scale: Mapped[str | None] = mapped_column(String(100))
    artifact_revision: Mapped[str | None] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    bom_format: Mapped[str | None] = mapped_column(String(50))
    bom_spec_version: Mapped[str | None] = mapped_column(String(20))
    bom_serial_number: Mapped[str | None] = mapped_column(String(100))
    bom_version: Mapped[str | None] = mapped_column(String(50))
    checklist_present_fields: Mapped[int | None]
    checklist_total_fields: Mapped[int | None]
    checklist_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    checklist_penalty_factor: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    source_generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False))
    details_json: Mapped[dict[str, Any]] = mapped_column(JSON)

    hierarchy: Mapped["ModelHierarchy"] = relationship(
        back_populates="model",
        foreign_keys="ModelHierarchy.model_id",
        uselist=False,
    )


class ModelHierarchy(Base):
    __tablename__ = "model_hierarchy"

    model_id: Mapped[str] = mapped_column(
        String(512), ForeignKey("model_info.model_id"), primary_key=True
    )
    parent_model_id: Mapped[str | None] = mapped_column(
        String(512), ForeignKey("model_info.model_id")
    )
    relationship_type: Mapped[str | None] = mapped_column(String(100))
    hierarchy_depth: Mapped[int]
    sibling_order: Mapped[int]
    change_details_json: Mapped[dict[str, Any] | None] = mapped_column(JSON)

    model: Mapped[ModelInfo] = relationship(
        back_populates="hierarchy", foreign_keys=[model_id]
    )


class ModelResearchResult(Base):
    """Stored AI research result for one requested model name and source."""

    __tablename__ = "model_research_result"

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    requested_model: Mapped[str] = mapped_column(String(512))
    source: Mapped[str] = mapped_column(String(20))
    status: Mapped[str | None] = mapped_column(String(20))
    result_model_id: Mapped[str | None] = mapped_column(String(512))
    research_model: Mapped[str | None] = mapped_column(String(255))
    result_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), default=datetime.utcnow)
